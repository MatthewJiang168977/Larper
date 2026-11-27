import type { Pool } from 'pg';

// Reading place_facts (migration 0023), the curator's hand-verified facts. Append-only: the
// latest row of a group is the current one. Opening hours are read with the other hours facts
// (hours/place-hours.ts).

export const VERDICTS = ['great', 'verified', 'closed', 'bad_fit'] as const;
export type Verdict = (typeof VERDICTS)[number];
export const FACT_KINDS = [...VERDICTS, 'hours', 'note'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** A place with one of these as its latest verdict is not offered. */
export const NOT_OFFERED: readonly Verdict[] = ['closed', 'bad_fit'];

export const MAX_NOTE_LENGTH = 140;

/** An insider note as the quest responses carry it: the text, where it came from and when. */
export interface InsiderNote {
  text: string;
  source: 'hand-verified';
  notedAt: string;
}

/** Which of these places the latest verdict rules out. One query. */
export async function loadRejected(pg: Pool, placeIds: readonly string[]): Promise<Set<string>> {
  if (!placeIds.length) return new Set();
  const { rows } = await pg.query<{ placeId: string }>(
    `SELECT place_id::text AS "placeId" FROM (
       SELECT DISTINCT ON (place_id) place_id, kind FROM place_facts
       WHERE place_id = ANY($1::bigint[]) AND kind = ANY($2::text[])
       ORDER BY place_id, created_at DESC, id DESC) v
     WHERE kind = ANY($3::text[])`,
    [placeIds, VERDICTS, NOT_OFFERED],
  );
  return new Set(rows.map((r) => r.placeId));
}

/** The current insider note of each of these places that has one. One query. */
export async function loadInsiderNotes(pg: Pool, placeIds: readonly string[]): Promise<Map<string, InsiderNote>> {
  if (!placeIds.length) return new Map();
  const { rows } = await pg.query<{ placeId: string; note: string | null; at: Date }>(
    `SELECT DISTINCT ON (place_id) place_id::text AS "placeId", note, created_at AS at FROM place_facts
     WHERE place_id = ANY($1::bigint[]) AND kind = 'note'
     ORDER BY place_id, created_at DESC, id DESC`,
    [placeIds],
  );
  return new Map(
    rows
      .filter((r) => r.note !== null)
      .map((r) => [r.placeId, { text: r.note!, source: 'hand-verified', notedAt: r.at.toISOString() }]),
  );
}
