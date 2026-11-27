import ngeohash from 'ngeohash';
import { VIBE_CARDS } from '../profile/cards';
import { seedTasteVector } from '../profile/taste';
import { cellOf, cellsCovering, haversineM } from '../quests/geo';
import { DECK_SIZE, MAX_CANDIDATES, rankCandidates, type RankRow } from '../quests/ranker';
import { AreaStats, DEFAULT_WEIGHTS, mmr, Weights } from '../quests/scoring';
import { DEFAULT_MIN_CONFIDENCE } from '../quests/eligibility';
import type { Rating } from './golden';

// The offline eval: replays the ranker for synthetic taste profiles at fixed points and counts
// how often the picks are places the curator rated great, or bad or closed. The curator's
// verdicts and the reliability score are NOT applied: that would grade the ranker with the
// answers. docs/plans/quality-engine.md, section 4.

export interface EvalPlace {
  id: string;
  overtureId: string;
  name: string;
  lat: number;
  lng: number;
  categories: string[];
  tags: string[];
  /** The place's tag vector, non-zero slots only: tag -> weight. */
  vec: Record<string, number>;
  confidence: number;
  chainLocations: number;
}

export const RADIUS_M = 1500;

/** Two fixed points in each focus neighbourhood. */
export const POINTS = [
  { name: 'East Village, Tompkins Sq', lat: 40.7265, lng: -73.9815 },
  { name: 'East Village, St Marks', lat: 40.7286, lng: -73.9876 },
  { name: 'Union Square, park', lat: 40.7359, lng: -73.9906 },
  { name: 'Union Square, east', lat: 40.7347, lng: -73.9878 },
  { name: 'Greenwich Village, Washington Sq', lat: 40.7308, lng: -73.9973 },
  { name: 'Greenwich Village, Bleecker', lat: 40.7295, lng: -74.0012 },
] as const;

/** Synthetic people, as sets of onboarding cards they liked. */
export const PROFILES: readonly (readonly string[])[] = [
  ['matcha', 'paper', 'crate-digging'],
  ['boba', 'line-dessert', 'photobooth'],
  ['line-dessert', 'matcha', 'green'],
  ['noodle-counter', 'late-night', 'dive'],
  ['counter-seat', 'natty-wine', 'live-set'],
  ['hidden-bar', 'live-set', 'natty-wine'],
  ['dive', 'games', 'late-night'],
  ['natty-wine', 'odd-museum', 'paper'],
  ['photobooth', 'games', 'boba'],
  ['games', 'thrift', 'noodle-counter'],
  ['crate-digging', 'thrift', 'odd-museum'],
  ['thrift', 'paper', 'matcha'],
  ['paper', 'odd-museum', 'green'],
  ['odd-museum', 'live-set', 'crate-digging'],
  ['live-set', 'hidden-bar', 'counter-seat'],
  ['green', 'bathhouse', 'matcha'],
  ['bathhouse', 'green', 'odd-museum'],
  ['late-night', 'noodle-counter', 'boba'],
  ['noodle-counter'],
  ['crate-digging'],
];

const NO_CARD_VEC = (liked: readonly string[], slots: ReadonlyMap<string, number>) =>
  seedTasteVector(
    VIBE_CARDS.filter((c) => liked.includes(c.id)),
    [],
    (t) => slots.get(t),
    slots.size,
  )!;

/** What pgvector computes: cosine similarity of the user's vector and the place's. */
function similarity(user: number[], slots: ReadonlyMap<string, number>, vec: Record<string, number>): number {
  let dot = 0;
  let norm = 0;
  for (const [tag, w] of Object.entries(vec)) {
    dot += (user[slots.get(tag)!] ?? 0) * w;
    norm += w * w;
  }
  const userNorm = Math.hypot(...user);
  return norm && userNorm ? dot / (Math.sqrt(norm) * userNorm) : 0;
}

/** The deck the service would build for this vector at this point, from these places. */
export function deckFor(
  places: readonly EvalPlace[],
  user: number[],
  slots: ReadonlyMap<string, number>,
  point: { lat: number; lng: number },
  weights: Weights = DEFAULT_WEIGHTS,
): { id: string; overtureId: string }[] {
  const center = cellOf(point.lat, point.lng); // the service ranks from the cell's center
  const cells = new Set(cellsCovering(center.lat, center.lng, RADIUS_M));
  const area: AreaStats = { total: 0, tagCounts: {} };
  for (const p of places) {
    if (!cells.has(ngeohash.encode(p.lat, p.lng, 6))) continue;
    area.total++;
    for (const t of p.tags) area.tagCounts[t] = (area.tagCounts[t] ?? 0) + 1;
  }
  const rows: RankRow[] = places
    .map((p) => ({ p, distanceM: haversineM(center.lat, center.lng, p.lat, p.lng) }))
    .filter((x) => x.distanceM <= RADIUS_M)
    .map(({ p, distanceM }) => ({
      id: p.id,
      overtureId: p.overtureId,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      category: p.categories[p.categories.length - 1] ?? '',
      categories: p.categories,
      tags: p.tags,
      taste: similarity(user, slots, p.vec),
      chainLocations: p.chainLocations,
      confidence: p.confidence,
      distanceM,
      website: null,
      instagram: null,
      phone: null,
    }))
    .sort((a, b) => b.taste - a.taste || a.id.length - b.id.length || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_CANDIDATES);
  const overture = new Map(rows.map((r) => [r.id, r.overtureId]));
  const weightOf = (tag: string) => user[slots.get(tag) ?? -1] ?? 0;
  const ranked = rankCandidates(rows, area, weightOf, { radiusM: RADIUS_M, minConfidence: DEFAULT_MIN_CONFIDENCE, weights });
  return mmr(ranked, DECK_SIZE).map((p) => ({ id: p.id, overtureId: overture.get(p.id)! }));
}

export interface EvalResult {
  runs: number;
  /** Share of runs whose first pick is rated great. */
  top1Great: number;
  /** Share of runs with a great place among the first three. */
  top3Great: number;
  /** Share of the first-three picks rated bad or closed. */
  badOrClosed: number;
  /** Share of the first-three picks the curator has rated at all: how much the rest can be trusted. */
  rated: number;
}

export function evaluate(places: readonly EvalPlace[], golden: ReadonlyMap<string, Rating>, weights: Weights = DEFAULT_WEIGHTS): EvalResult {
  // Slots for every tag the places or the cards use.
  const tags = new Set([...VIBE_CARDS.flatMap((c) => c.tags), ...places.flatMap((p) => [...p.tags, ...Object.keys(p.vec)])]);
  const slots = new Map([...tags].sort().map((t, i) => [t, i]));

  let runs = 0;
  let top1 = 0;
  let top3 = 0;
  let bad = 0;
  let rated = 0;
  let slotsShown = 0;
  for (const liked of PROFILES) {
    const user = NO_CARD_VEC(liked, slots);
    for (const point of POINTS) {
      const picks = deckFor(places, user, slots, point, weights).slice(0, 3);
      if (!picks.length) continue;
      runs++;
      const ratings = picks.map((p) => golden.get(p.overtureId));
      if (ratings[0] === 'great') top1++;
      if (ratings.includes('great')) top3++;
      bad += ratings.filter((r) => r === 'bad' || r === 'closed').length;
      rated += ratings.filter(Boolean).length;
      slotsShown += picks.length;
    }
  }
  const share = (n: number, d: number) => (d ? Math.round((n / d) * 10_000) / 10_000 : 0);
  return {
    runs,
    top1Great: share(top1, runs),
    top3Great: share(top3, runs),
    badOrClosed: share(bad, slotsShown),
    rated: share(rated, slotsShown),
  };
}

/** How much worse than the baseline a change may be before it fails. */
export const MARGINS = { top1Great: 0.05, badOrClosed: 0.02 };

/** Why this result fails against the baseline; empty when it passes. */
export function regressions(result: EvalResult, baseline: EvalResult): string[] {
  const out: string[] = [];
  if (!result.runs) out.push('no runs: no place was in range of any point');
  const eps = 1e-9;
  if (baseline.top1Great - result.top1Great > MARGINS.top1Great + eps) {
    out.push(`top-1 great fell from ${baseline.top1Great} to ${result.top1Great} (margin ${MARGINS.top1Great})`);
  }
  if (result.badOrClosed - baseline.badOrClosed > MARGINS.badOrClosed + eps) {
    out.push(`bad or closed rose from ${baseline.badOrClosed} to ${result.badOrClosed} (margin ${MARGINS.badOrClosed})`);
  }
  return out;
}

export function report(title: string, r: EvalResult): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return [
    `# ${title}`,
    '',
    `${PROFILES.length} synthetic taste profiles at ${POINTS.length} points, ${r.runs} runs.`,
    '',
    '| Measure | Value |',
    '|---|---|',
    `| Top-1 pick rated great | ${pct(r.top1Great)} |`,
    `| A great place in the top 3 | ${pct(r.top3Great)} |`,
    `| Top-3 picks rated bad or closed | ${pct(r.badOrClosed)} |`,
    `| Top-3 picks with any rating | ${pct(r.rated)} |`,
    '',
  ].join('\n');
}
