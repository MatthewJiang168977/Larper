// Niche score v1. Pure functions so the math is testable without a database.
//
//   score(p) = (w.taste·fit + w.rarity·rarity) · indieFactor · qualityFactor · decay(d)
//
// fit       cosine(user, place) / best cosine among the candidates, in [0,1]. Raw cosine
//           is compressed for broad profiles (liking 12 cards spreads weight over ~45
//           tags, capping cosine near 0.3), so fit is relative to "best match around here".
// rarity    how unusual p's rarest tag is around here: log(N/n_tag) / log(N), in [0,1]
// indie     1 / (1 + ln(locations of this chain)): 1 for a one-off, ~0.13 for Dunkin'
// quality   Overture's confidence that the place exists as described
// decay     exp(-d / d0)
//
// indie and quality are multipliers, not added terms: they can demote a good match but
// never make a bad one good. (As added terms they gave every indie place a floor that
// drowned out taste.)

export interface Weights {
  taste: number;
  rarity: number;
  indie: number; // max fraction a big chain loses
  quality: number; // max fraction a zero-confidence listing loses
}

export const DEFAULT_WEIGHTS: Weights = { taste: 0.7, rarity: 0.3, indie: 0.4, quality: 0.25 };

// QUEST_WEIGHTS='{"taste":0.6,...}' overrides any subset, for tuning without a deploy.
export function weightsFromEnv(raw = process.env.QUEST_WEIGHTS): Weights {
  if (!raw) return DEFAULT_WEIGHTS;
  return { ...DEFAULT_WEIGHTS, ...(JSON.parse(raw) as Partial<Weights>) };
}

/** Tag counts for the area around the user: N places in total, n per tag. */
export interface AreaStats {
  total: number;
  tagCounts: Record<string, number>;
}

export interface Candidate {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: string; // most specific Overture category, for display
  tags: string[];
  taste: number; // cosine similarity in [-1, 1]
  chainLocations: number;
  confidence: number;
  distanceM: number;
}

export interface Reasons {
  liked: string[]; // the place's tags the user leans toward, strongest first
  rarest: { tag: string; nearby: number } | null; // its rarest tag and how many share it nearby
  indie: boolean;
}

export interface Scored extends Candidate {
  score: number;
  parts: { fit: number; rarity: number; indie: number; quality: number; decay: number };
  reasons: Reasons;
}

export function rarity(tags: string[], area: AreaStats): { value: number; tag: string | null; nearby: number } {
  let best = { value: 0, tag: null as string | null, nearby: 0 };
  if (area.total < 2) return best;
  for (const tag of tags) {
    // A tag missing from the stats is at least as rare as one occurrence.
    const n = Math.max(1, area.tagCounts[tag] ?? 1);
    const value = Math.log(area.total / n) / Math.log(area.total);
    if (value > best.value) best = { value, tag, nearby: n };
  }
  return best;
}

export const indie = (chainLocations: number) => 1 / (1 + Math.log(Math.max(1, chainLocations)));

export const decay = (distanceM: number, d0: number) => Math.exp(-distanceM / d0);

export function score(
  c: Candidate,
  area: AreaStats,
  userWeightOf: (tag: string) => number,
  ctx: { bestTaste: number; d0: number },
  w: Weights = DEFAULT_WEIGHTS,
): Scored {
  const r = rarity(c.tags, area);
  const parts = {
    fit: ctx.bestTaste > 0 ? Math.max(0, c.taste) / ctx.bestTaste : 0,
    rarity: r.value,
    indie: indie(c.chainLocations),
    quality: c.confidence,
    decay: decay(c.distanceM, ctx.d0),
  };
  const s =
    (w.taste * parts.fit + w.rarity * parts.rarity) *
    (1 - w.indie * (1 - parts.indie)) *
    (1 - w.quality * (1 - parts.quality)) *
    parts.decay;
  const liked = c.tags
    .map((t) => ({ t, w: userWeightOf(t) }))
    .filter((x) => x.w > 0)
    .sort((a, b) => b.w - a.w)
    .map((x) => x.t);
  return {
    ...c,
    score: s,
    parts,
    reasons: { liked, rarest: r.tag ? { tag: r.tag, nearby: r.nearby } : null, indie: c.chainLocations <= 1 },
  };
}

const jaccard = (a: string[], b: string[]) => {
  const sb = new Set(b);
  const inter = a.filter((x) => sb.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
};

// Maximal marginal relevance: greedily pick the item that best trades its own score
// against similarity (tag overlap) to what's already picked, so the deck isn't ten
// matcha bars. lambda=1 is pure score order; lower values diversify harder.
export function mmr<T extends { score: number; tags: string[] }>(items: T[], k: number, lambda = 0.7): T[] {
  const pool = [...items].sort((a, b) => b.score - a.score);
  const picked: T[] = [];
  while (picked.length < k && pool.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const sim = picked.length ? Math.max(...picked.map((p) => jaccard(p.tags, pool[i].tags))) : 0;
      const val = lambda * pool[i].score - (1 - lambda) * sim;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    picked.push(pool.splice(bestIdx, 1)[0]);
  }
  return picked;
}
