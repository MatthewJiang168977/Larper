import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG } from '../db/db.module';
import { rankPilotCandidates, type PilotPlace } from '../hours-pilot/candidates';
import { HoursTextError, parseHoursText } from '../hours/parse';
import { HAND_HOURS_MAX_AGE_DAYS } from '../hours/place-hours';
import { BLOCKED_CATEGORIES, CATEGORY_EXCEPTION_IDS, MIN_CONFIDENCE } from '../quests/eligibility';
import { FACT_KINDS, MAX_NOTE_LENGTH, VERDICTS, type FactKind, type Verdict } from './place-facts';
import { NEIGHBORHOODS, polygonGeoJson, type Neighborhood } from './neighborhoods';

/** The most places one neighbourhood lists, most likely to be offered first. */
export const LIST_LIMIT = 150;
const REPORTS_PER_PLACE = 5;
const DAY_TIME_ZONE = 'America/New_York';

export interface CurationHours {
  source: string;
  /** The hours as the source wrote them; null: cleared. */
  text: string | null;
  service: string;
  at: string;
  expired: boolean;
}
export interface CurationReport {
  kind: 'was_open' | 'wasnt_open' | 'skipped_closed';
  /** The New York day. Never who. */
  day: string;
}
export interface CurationFacts {
  verdict: { kind: Verdict; at: string; expired: boolean } | null;
  note: { text: string; at: string } | null;
  hours: CurationHours[];
  reports: CurationReport[];
}
export interface CurationPlace extends CurationFacts {
  id: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  /** The places table stores no street address. */
  address: null;
  website: string | null;
  instagram: string | null;
}

// The static pre-filter the quest ranking uses (quests.service candidates()), for one polygon.
// The gate and its dedupe are re-applied in rankPilotCandidates.
const PLACES_SQL = `
  SELECT p.id::text, p.name, p.overture_id AS "overtureId", ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lng,
         p.categories, p.categories[array_length(p.categories, 1)] AS category, p.tags,
         p.confidence::float8 AS confidence, p.chain_locations AS "chainLocations",
         p.website, p.phone, p.instagram
  FROM places p
  WHERE ST_Intersects(p.geom::geometry, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))
    AND p.location_suspect IS NULL
    AND p.confidence >= $2::real
    AND (p.overture_id = ANY($4::text[]) OR
         NOT EXISTS (SELECT FROM unnest(p.categories) c WHERE lower(c) = ANY($3::text[])))`;

type PlaceRow = Omit<PilotPlace, 'address' | 'neighborhood'> & { instagram: string | null };

const olderThan = (at: Date, days: number, now: Date) => now.getTime() - at.getTime() > days * 86_400_000;

@Injectable()
export class CurationService {
  constructor(@Inject(PG) private readonly pg: Pool) {}

  async list(slug: string, now = new Date()) {
    const area = NEIGHBORHOODS.find((n) => n.slug === slug);
    if (!area) throw new BadRequestException(`area must be one of ${NEIGHBORHOODS.map((n) => n.slug).join(', ')}`);
    const ranked = await this.ranked(area);
    const top = ranked.slice(0, LIST_LIMIT);
    const facts = await this.facts(top.map((p) => p.id), now);
    return {
      areas: NEIGHBORHOODS.map(({ slug, name }) => ({ slug, name })),
      area: area.slug,
      total: ranked.length,
      places: top.map(
        (p): CurationPlace => ({
          id: p.id,
          name: p.name,
          category: p.category,
          lat: p.lat,
          lng: p.lng,
          address: null,
          website: p.website,
          instagram: p.instagram,
          ...facts.get(p.id)!,
        }),
      ),
    };
  }

  // "How likely to be offered": the quest score without anyone's taste or distance.
  private async ranked(area: Neighborhood) {
    const { rows } = await this.pg.query<PlaceRow>(PLACES_SQL, [
      polygonGeoJson(area),
      MIN_CONFIDENCE,
      BLOCKED_CATEGORIES,
      CATEGORY_EXCEPTION_IDS,
    ]);
    const instagram = new Map(rows.map((r) => [r.id, r.instagram]));
    return rankPilotCandidates(
      rows.map((r) => ({ ...r, address: null, neighborhood: area.name })),
      Number.MAX_SAFE_INTEGER,
    ).map((p) => ({ ...p, instagram: instagram.get(p.id) ?? null }));
  }

  /** Everything the card shows about each place, in three queries. */
  async facts(placeIds: readonly string[], now = new Date()): Promise<Map<string, CurationFacts>> {
    const out = new Map<string, CurationFacts>(
      placeIds.map((id) => [id, { verdict: null, note: null, hours: [], reports: [] }]),
    );
    if (!placeIds.length) return out;

    const current = await this.pg.query<{ placeId: string; grp: string; kind: FactKind; note: string | null; raw: string | null; at: Date }>(
      `SELECT DISTINCT ON (place_id, grp) place_id::text AS "placeId", grp, kind, note, hours_raw AS raw, created_at AS at
       FROM (SELECT *, CASE WHEN kind = ANY($2::text[]) THEN 'verdict' ELSE kind END AS grp
             FROM place_facts WHERE place_id = ANY($1::bigint[])) f
       ORDER BY place_id, grp, created_at DESC, id DESC`,
      [placeIds, VERDICTS],
    );
    for (const r of current.rows) {
      const f = out.get(r.placeId)!;
      if (r.grp === 'verdict') {
        const kind = r.kind as Verdict;
        const positive = kind === 'great' || kind === 'verified';
        f.verdict = { kind, at: r.at.toISOString(), expired: positive && olderThan(r.at, HAND_HOURS_MAX_AGE_DAYS, now) };
      } else if (r.grp === 'note') {
        if (r.note !== null) f.note = { text: r.note, at: r.at.toISOString() };
      } else {
        f.hours.push({
          source: 'hand-verified',
          text: r.raw,
          service: 'regular',
          at: r.at.toISOString(),
          expired: olderThan(r.at, HAND_HOURS_MAX_AGE_DAYS, now),
        });
      }
    }

    const imported = await this.pg.query<{ placeId: string; source: string; service: string; raw: string | null; at: Date }>(
      `SELECT place_id::text AS "placeId", source, service, raw, fetched_at AS at FROM place_hours_facts
       WHERE place_id = ANY($1::bigint[]) AND kind = 'schedule' ORDER BY fetched_at DESC, id DESC`,
      [placeIds],
    );
    for (const r of imported.rows) {
      out.get(r.placeId)!.hours.push({
        source: r.source,
        text: r.raw,
        service: r.service,
        at: r.at.toISOString(),
        expired: r.source === 'manual' && olderThan(r.at, HAND_HOURS_MAX_AGE_DAYS, now),
      });
    }

    // Check-in answers and "closed" skips, newest first: the day and what was said, no one.
    const reports = await this.pg.query<{ placeId: string; kind: CurationReport['kind']; day: string }>(
      `SELECT "placeId", kind, day FROM (
         SELECT "placeId", kind, to_char(at AT TIME ZONE $2, 'YYYY-MM-DD') AS day,
                row_number() OVER (PARTITION BY "placeId" ORDER BY at DESC) AS n
         FROM (
           SELECT place_id::text AS "placeId", CASE WHEN was_open THEN 'was_open' ELSE 'wasnt_open' END AS kind, fetched_at AS at
           FROM place_hours_facts
           WHERE place_id = ANY($1::bigint[]) AND kind = 'observation' AND was_open IS NOT NULL
           UNION ALL
           SELECT place_id::text, 'skipped_closed', updated_at FROM quests
           WHERE place_id = ANY($1::bigint[]) AND skip_reason = 'closed'
         ) r
       ) ranked WHERE n <= $3 ORDER BY "placeId", n`,
      [placeIds, DAY_TIME_ZONE, REPORTS_PER_PLACE],
    );
    for (const r of reports.rows) out.get(r.placeId)!.reports.push({ kind: r.kind, day: r.day });
    return out;
  }

  /** Records one fact, by `userId`, and answers with the place's facts as they are now. */
  async record(userId: string, placeId: string, body: { kind?: unknown; note?: unknown; hours?: unknown }) {
    const kind = body.kind;
    if (typeof kind !== 'string' || !(FACT_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException(`kind must be one of ${FACT_KINDS.join(', ')}`);
    }
    let note: string | null = null;
    let raw: string | null = null;
    let schedule: string | null = null;
    if (kind === 'note') {
      if (typeof body.note !== 'string') throw new BadRequestException('note must be text (empty to clear it)');
      const text = body.note.trim();
      if (/[\n\r]/.test(text)) throw new BadRequestException('a note is one line');
      // Code points, as Postgres' char_length counts them.
      if ([...text].length > MAX_NOTE_LENGTH) throw new BadRequestException(`a note is at most ${MAX_NOTE_LENGTH} characters`);
      note = text || null;
    }
    if (kind === 'hours') {
      if (typeof body.hours !== 'string') throw new BadRequestException('hours must be text (empty to clear them)');
      const text = body.hours.trim();
      if (text) {
        try {
          schedule = JSON.stringify(parseHoursText(text));
        } catch (err) {
          if (err instanceof HoursTextError) throw new BadRequestException(err.message);
          throw err;
        }
        raw = text;
      }
    }
    await this.insert(userId, placeId, kind as FactKind, note, raw, schedule);
    return { id: placeId, ...(await this.facts([placeId])).get(placeId)! };
  }

  private async insert(userId: string, placeId: string, kind: FactKind, note: string | null, raw: string | null, schedule: string | null) {
    const { rowCount } = await this.pg.query(
      `INSERT INTO place_facts (place_id, kind, user_id, note, hours_raw, schedule)
       SELECT id, $2, $3, $4, $5, $6::jsonb FROM places WHERE id = $1`,
      [placeId, kind, userId, note, raw, schedule],
    );
    if (!rowCount) throw new NotFoundException('no such place');
  }
}
