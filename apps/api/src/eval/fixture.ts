import { VIBE_CARDS } from '../profile/cards';
import type { EvalPlace } from './eval';
import { POINTS } from './eval';
import type { Rating } from './golden';

// SYNTHETIC places and ratings for the CI eval. None of this describes a real place: the
// names say so, the ids start "synthetic-", and nothing here is ever loaded into a database
// or written to data/golden-places.csv. Deterministic (a fixed seed), so the baseline holds.

function random(seed: number): () => number {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FIXTURE_SIZE = 600;

export function fixture(seed = 20261126): { places: EvalPlace[]; golden: Map<string, Rating> } {
  const next = random(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)];
  const tags = [...new Set(VIBE_CARDS.flatMap((c) => c.tags))].sort();
  const places: EvalPlace[] = [];
  const golden = new Map<string, Rating>();
  for (let i = 0; i < FIXTURE_SIZE; i++) {
    const at = pick(POINTS);
    const own = [...new Set([pick(tags), ...(next() < 0.4 ? [pick(tags)] : [])])];
    const confidence = 0.55 + next() * 0.45;
    const chainLocations = next() < 0.15 ? 2 + Math.floor(next() * 40) : 1;
    const overtureId = `synthetic-${String(i).padStart(4, '0')}`;
    places.push({
      id: String(i + 1),
      overtureId,
      name: `Synthetic place ${i}`,
      lat: at.lat + (next() - 0.5) * 0.012,
      lng: at.lng + (next() - 0.5) * 0.016,
      categories: ['synthetic', own[0]],
      tags: own,
      vec: Object.fromEntries(own.map((t) => [t, 1 / Math.sqrt(own.length)])),
      confidence,
      chainLocations,
    });
    // Ratings loosely follow what the ranker can see (chains and doubtful listings rate
    // worse), so a scoring change that ignores them shows up.
    const quality = next() + (chainLocations > 1 ? -0.35 : 0.1) + (confidence - 0.8);
    golden.set(overtureId, quality > 0.7 ? 'great' : quality > 0.25 ? 'fine' : quality > 0 ? 'bad' : 'closed');
  }
  return { places, golden };
}
