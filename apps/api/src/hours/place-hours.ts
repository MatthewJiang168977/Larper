import type { Pool } from 'pg';
import { localTime, isoWeekday, nextChange, spansOn, stateAt, validateSchedule, type DisplaySpan, type NextChange, type OpenState, type Schedule } from './schedule';

// Reading place_hours_facts (migration 0018) into what the quest responses carry. Missing
// data is never "closed": a place with no usable schedule is 'unverified', and a schedule
// that cannot say is 'unknown'.

/** A schedule fact below this confidence is not used. */
export const MIN_HOURS_CONFIDENCE = 0.5;
/** "Open" confirmations older than this are not counted. */
export const CONFIRMATION_WINDOW_DAYS = 180;
const NYC = 'America/New_York';

export type HoursSource = 'osm' | 'website' | 'nyc_open_data' | 'alltheplaces' | 'manual';
export type ServiceKind = 'kitchen' | 'bar';

export interface HoursService {
  kind: ServiceKind;
  state: OpenState;
  today: DisplaySpan[];
}
export type PlaceHours =
  | { status: 'unverified' }
  | {
      status: 'known';
      state: OpenState;
      today: DisplaySpan[];
      nextChange: NextChange | null;
      source: HoursSource;
      sourceUrl: string | null;
      fetchedAt: string;
      services: HoursService[];
    };

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export interface OpenConfirmations {
  count: number;
  last: { day: (typeof DAYS)[number]; part: 'morning' | 'afternoon' | 'evening' | 'night' };
}

export interface PlaceHoursInfo {
  hours: PlaceHours;
  openConfirmations: OpenConfirmations | null;
}

export const NO_HOURS: PlaceHoursInfo = { hours: { status: 'unverified' }, openConfirmations: null };

export interface ScheduleFact {
  placeId: string;
  id: string;
  service: 'regular' | ServiceKind;
  source: HoursSource;
  sourceUrl: string | null;
  fetchedAt: Date;
  confidence: number;
  schedule: unknown;
}

interface Chosen {
  fact: ScheduleFact;
  schedule: Schedule;
}

/**
 * Per place and service, the usable schedule: valid JSON, confidence at least
 * MIN_HOURS_CONFIDENCE, then the highest confidence, ties to the newest fetched_at (and the
 * higher id, so the answer never depends on row order). An invalid schedule is skipped, so
 * the next best fact can stand, and with none the place is unverified.
 */
export function chooseSchedules(facts: readonly ScheduleFact[]): Map<string, Map<ScheduleFact['service'], Chosen>> {
  const sorted = facts
    .filter((f) => f.confidence >= MIN_HOURS_CONFIDENCE)
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        b.fetchedAt.getTime() - a.fetchedAt.getTime() ||
        (a.id.length !== b.id.length ? b.id.length - a.id.length : a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
  const out = new Map<string, Map<ScheduleFact['service'], Chosen>>();
  for (const fact of sorted) {
    const byService = out.get(fact.placeId) ?? new Map();
    if (byService.has(fact.service)) continue;
    const schedule = validateSchedule(fact.schedule);
    if (!schedule) continue;
    byService.set(fact.service, { fact, schedule });
    out.set(fact.placeId, byService);
  }
  return out;
}

const SCHEDULE_COLUMNS = `place_id::text AS "placeId", id::text, service, source, source_url AS "sourceUrl",
              fetched_at AS "fetchedAt", confidence::float8 AS confidence, schedule`;

/** The best regular schedule of each of these places that has one (the trust gate's evening rule). One query. */
export async function loadRegularSchedules(pg: Pool, placeIds: readonly string[]): Promise<Map<string, Schedule>> {
  if (!placeIds.length) return new Map();
  const { rows } = await pg.query<ScheduleFact>(
    `SELECT ${SCHEDULE_COLUMNS}
     FROM place_hours_facts
     WHERE place_id = ANY($1::bigint[]) AND kind = 'schedule' AND service = 'regular' AND confidence >= $2::real`,
    [placeIds, MIN_HOURS_CONFIDENCE],
  );
  const out = new Map<string, Schedule>();
  for (const [placeId, byService] of chooseSchedules(rows)) {
    const regular = byService.get('regular');
    if (regular) out.set(placeId, regular.schedule);
  }
  return out;
}

/** Day of week and part of day in New York for an 'open' confirmation. No date, no exact time. */
export function confirmationBucket(at: Date): OpenConfirmations['last'] {
  const t = localTime(at, NYC);
  // morning 05:00-11:59, afternoon 12:00-16:59, evening 17:00-21:59, night 22:00-04:59
  const part =
    t.min >= 22 * 60 || t.min < 5 * 60 ? 'night' : t.min < 12 * 60 ? 'morning' : t.min < 17 * 60 ? 'afternoon' : 'evening';
  return { day: DAYS[isoWeekday(t) - 1], part };
}

interface Row extends Partial<ScheduleFact> {
  k: 'schedule' | 'confirmations';
  placeId: string;
  n: number | null;
  last: Date | null;
}

/**
 * What the quest responses say about hours for these places, in ONE query: the schedule facts
 * (above the confidence floor) and, per place, the count of distinct people who answered "open"
 * in the last 180 days with the newest answer's time. `now` is the clock the rest of the
 * response uses.
 */
export async function loadPlaceHours(pg: Pool, placeIds: readonly string[], now: Date): Promise<Map<string, PlaceHoursInfo>> {
  const out = new Map<string, PlaceHoursInfo>();
  if (!placeIds.length) return out;
  const { rows } = await pg.query<Row>(
    `SELECT 'schedule' AS k, ${SCHEDULE_COLUMNS}, NULL::int AS n, NULL::timestamptz AS last
     FROM place_hours_facts
     WHERE place_id = ANY($1::bigint[]) AND kind = 'schedule' AND confidence >= $2::real
     UNION ALL
     SELECT 'confirmations', place_id::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            count(DISTINCT user_id)::int, max(fetched_at)
     FROM place_hours_facts
     WHERE place_id = ANY($1::bigint[]) AND kind = 'observation' AND was_open IS TRUE
       AND fetched_at > $3::timestamptz - make_interval(days => $4)
     GROUP BY place_id`,
    [placeIds, MIN_HOURS_CONFIDENCE, now, CONFIRMATION_WINDOW_DAYS],
  );

  const chosen = chooseSchedules(rows.filter((r) => r.k === 'schedule') as ScheduleFact[]);
  for (const id of placeIds) {
    const regular = chosen.get(id)?.get('regular');
    let hours: PlaceHours = { status: 'unverified' };
    if (regular) {
      const { fact, schedule } = regular;
      const services: HoursService[] = [];
      for (const kind of ['kitchen', 'bar'] as const) {
        const c = chosen.get(id)?.get(kind);
        if (c) services.push({ kind, state: stateAt(c.schedule, now), today: spansOn(c.schedule, now) });
      }
      hours = {
        status: 'known',
        state: stateAt(schedule, now),
        today: spansOn(schedule, now),
        nextChange: nextChange(schedule, now),
        source: fact.source as HoursSource,
        sourceUrl: fact.sourceUrl,
        fetchedAt: fact.fetchedAt.toISOString(),
        services,
      };
    }
    const conf = rows.find((r) => r.k === 'confirmations' && r.placeId === id);
    const openConfirmations =
      conf && conf.n && conf.last ? { count: conf.n, last: confirmationBucket(conf.last) } : null;
    out.set(id, { hours, openConfirmations });
  }
  return out;
}
