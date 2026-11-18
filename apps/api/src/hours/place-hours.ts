import { BadRequestException } from '@nestjs/common';
import type { Pool } from 'pg';
import { nextChange, spansOn, stateAt, validateSchedule, type DisplaySpan, type NextChange, type OpenState, type Schedule } from './schedule';

// Reading place_hours_facts (migration 0018) into what the quest responses carry. Missing
// data is never "closed": a place with no usable schedule is 'unverified', and a schedule
// that cannot say is 'unknown'.

/** A schedule fact below this confidence is not used. */
export const MIN_HOURS_CONFIDENCE = 0.5;
/** "Open" confirmations older than this are not counted. */
export const CONFIRMATION_WINDOW_DAYS = 180;
/**
 * Check-in answers are shown only once this many different people gave one. Fewer, and nothing
 * derived from them leaves the API (not the count, not when): one or two people's visits could
 * be recognised by whoever knows they went.
 */
export const MIN_CONFIRMATIONS = 3;

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

/** How long ago the newest confirmation was, coarsely: never a day or a time. */
export type ConfirmationRecency = 'this_week' | 'this_month' | 'a_while_ago';
export interface OpenConfirmations {
  count: number;
  last: ConfirmationRecency;
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

/**
 * An hours observation (kind 'observation') always belongs to a user: the database says so too
 * (migration 0019's CHECK). Validate the positive PostgreSQL bigint before the first query.
 */
export function requireObserver(userId: unknown): string {
  if (typeof userId !== 'string' || !/^[1-9]\d{0,18}$/.test(userId) || BigInt(userId) > 9_223_372_036_854_775_807n) {
    throw new BadRequestException('an hours observation needs a user');
  }
  return userId;
}

const DAY_MS = 86_400_000;

/** Within 7 days of `now`: this week; within 30: this month; older: a while ago. A time slightly ahead of `now` (clock skew) is this week. */
export function confirmationRecency(at: Date, now: Date): ConfirmationRecency {
  const days = (now.getTime() - at.getTime()) / DAY_MS;
  return days <= 7 ? 'this_week' : days <= 30 ? 'this_month' : 'a_while_ago';
}

/** What a place's open confirmations show: nothing below MIN_CONFIRMATIONS people, else the count and the coarse recency. */
export function openConfirmations(count: number | null, last: Date | null, now: Date): OpenConfirmations | null {
  if (!count || !last || count < MIN_CONFIRMATIONS) return null;
  return { count, last: confirmationRecency(last, now) };
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
 * in the last 180 days with the newest answer's time (which only leaves here as a coarse recency, and only for 3 or more people). `now` is the clock the rest of the
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
    out.set(id, { hours, openConfirmations: openConfirmations(conf?.n ?? null, conf?.last ?? null, now) });
  }
  return out;
}
