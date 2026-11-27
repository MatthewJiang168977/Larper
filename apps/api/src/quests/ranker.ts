import { applyStaticGate, type GateItem } from './eligibility';
import { AreaStats, Candidate, score, Scored, Weights } from './scoring';

// The pure part of ranking, shared by the service (quests.service rank()) and the offline eval
// (src/eval), so the eval fails when a change here makes the picks worse. The SQL part (radius,
// candidate limit, taste similarity, area stats) is in the service; the eval does it in memory.

export const DECK_SIZE = 10;
export const CACHED_TOP_N = 200; // enough headroom to survive exclusions + MMR
export const MAX_CANDIDATES = 3000;

export type RankRow = Candidate & GateItem;

export function rankCandidates(
  rows: readonly RankRow[],
  area: AreaStats,
  weightOf: (tag: string) => number,
  opts: { radiusM: number; minConfidence: number; weights: Weights },
): Scored[] {
  // The trust gate, before scoring, so the cached deck is already clean (the query filtered
  // confidence and categories too, so its LIMIT isn't spent on them; this is the rules'
  // source of truth, and the dedupe only happens here).
  const candidates: Candidate[] = applyStaticGate(rows, opts.minConfidence).map((row) => {
    const c: Candidate & { categories?: readonly string[]; overtureId?: string } = { ...row };
    delete c.categories;
    delete c.overtureId;
    return c;
  });
  // A great match at the edge of the radius keeps ~37% of its score: worth the walk.
  const ctx = { bestTaste: Math.max(0, ...candidates.map((c) => c.taste)), d0: opts.radiusM };
  return candidates
    .map((c) => score(c, area, weightOf, ctx, opts.weights))
    .sort((a, b) => b.score - a.score)
    .slice(0, CACHED_TOP_N);
}
