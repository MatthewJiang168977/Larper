import type { VibeCard } from './cards';

// A passed card nudges away from its tags, but much less than a like pulls toward
// them: "not tonight" is weaker evidence than "yes, this".
export const PASS_WEIGHT = -0.25;

// Builds the initial taste vector from onboarding swipes. Each card contributes a
// unit vector over its tags (so a 5-tag card doesn't outvote a 2-tag card), scaled
// by +1 for a like and PASS_WEIGHT for a pass. The result is L2-normalized so it
// lives on the same scale as place vectors for cosine similarity.
// Returns null without at least one like: there's nothing to recommend from.
export function seedTasteVector(
  liked: VibeCard[],
  passed: VibeCard[],
  slotOf: (tag: string) => number | undefined,
  dims: number,
): number[] | null {
  if (liked.length === 0) return null;
  const vec = new Array<number>(dims).fill(0);
  const add = (card: VibeCard, scale: number) => {
    const per = scale / Math.sqrt(card.tags.length);
    for (const tag of card.tags) {
      const slot = slotOf(tag);
      if (slot === undefined) throw new Error(`unknown tag ${tag}`);
      vec[slot] += per;
    }
  };
  liked.forEach((c) => add(c, 1));
  passed.forEach((c) => add(c, PASS_WEIGHT));

  const norm = Math.hypot(...vec);
  if (norm === 0) return null;
  return vec.map((x) => x / norm);
}

// Tags with the largest positive weight, for "because you like ..." copy.
export function topTags(vec: number[], tagOf: (slot: number) => string | undefined, n = 5): string[] {
  return vec
    .map((w, slot) => ({ w, tag: tagOf(slot) }))
    .filter((x): x is { w: number; tag: string } => x.w > 0 && x.tag !== undefined)
    .sort((a, b) => b.w - a.w)
    .slice(0, n)
    .map((x) => x.tag);
}

export const toVectorLiteral = (v: number[]) => `[${v.join(',')}]`;
