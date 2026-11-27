import type { Pool } from 'pg';

// Reading place_reliability (migration 0024), which the reliability-worker keeps: what
// eligibility does with the estimate that a place is open and as described.
// docs/plans/quality-engine.md, section 2.

// The same constants as workers/internal/reliability (reliability.spec.ts checks them).
export const PRIOR_SUCCESS = 4;
export const PRIOR_FAILURE = 1;
export const HALF_LIFE_DAYS = 60;
/** The score of a place nobody has reported on. Below it, a place is demoted. */
export const PRIOR_MEAN = PRIOR_SUCCESS / (PRIOR_SUCCESS + PRIOR_FAILURE);

export interface Reliability {
  successes: number;
  failures: number;
  asOf: Date;
  suspendedAt: Date | null;
}

/** The estimate at `now`: the stored evidence, decayed since it was computed. */
export function reliabilityScore(r: Pick<Reliability, 'successes' | 'failures' | 'asOf'>, now: Date): number {
  const days = Math.max(0, now.getTime() - r.asOf.getTime()) / 86_400_000;
  const d = 0.5 ** (days / HALF_LIFE_DAYS);
  const s = PRIOR_SUCCESS + r.successes * d;
  return s / (s + PRIOR_FAILURE + r.failures * d);
}

export async function loadReliability(pg: Pool, placeIds: readonly string[]): Promise<Map<string, Reliability>> {
  if (!placeIds.length) return new Map();
  const { rows } = await pg.query<Reliability & { placeId: string }>(
    `SELECT place_id::text AS "placeId", successes::float8 AS successes, failures::float8 AS failures,
            as_of AS "asOf", suspended_at AS "suspendedAt"
     FROM place_reliability WHERE place_id = ANY($1::bigint[])`,
    [placeIds],
  );
  return new Map(rows.map((r) => [r.placeId, r]));
}

/** Drops suspended places and scales down the score of those below the prior. */
export function applyReliability<T extends { id: string; score: number }>(
  candidates: readonly T[],
  reliability: ReadonlyMap<string, Reliability>,
  now: Date,
): T[] {
  return candidates.flatMap((c) => {
    const r = reliability.get(c.id);
    if (!r) return [c];
    if (r.suspendedAt) return [];
    const factor = Math.min(1, reliabilityScore(r, now) / PRIOR_MEAN);
    return [factor < 1 ? { ...c, score: c.score * factor } : c];
  });
}
