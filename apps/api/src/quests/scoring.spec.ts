import { Candidate, decay, indie, mmr, rarity, score, weightsFromEnv } from './scoring';

const area = { total: 1000, tagCounts: { cafe: 200, matcha: 2, hojicha: 1 } };

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  id: '1', name: 'x', lat: 0, lng: 0, category: 'cafe', tags: ['cafe'],
  taste: 0.5, chainLocations: 1, confidence: 0.9, distanceM: 0,
  website: null, instagram: null, phone: null, ...over,
});

describe('rarity', () => {
  it('uses the rarest tag and reports how many share it', () => {
    const r = rarity(['cafe', 'matcha'], area);
    expect(r.tag).toBe('matcha');
    expect(r.nearby).toBe(2);
    expect(r.value).toBeCloseTo(Math.log(500) / Math.log(1000));
  });

  it('is 1 for a tag seen once and lower for common tags', () => {
    expect(rarity(['hojicha'], area).value).toBeCloseTo(1);
    expect(rarity(['cafe'], area).value).toBeLessThan(rarity(['matcha'], area).value);
  });

  it('is 0 when the area has no stats', () => {
    expect(rarity(['matcha'], { total: 0, tagCounts: {} }).value).toBe(0);
  });
});

describe('indie and decay', () => {
  it('scores one-offs 1 and big chains low', () => {
    expect(indie(1)).toBe(1);
    expect(indie(904)).toBeLessThan(0.15);
  });

  it('decays with distance', () => {
    expect(decay(0, 750)).toBe(1);
    expect(decay(750, 750)).toBeCloseTo(Math.exp(-1));
  });
});

describe('score', () => {
  const userWeight = (t: string) => ({ matcha: 0.6, hojicha: 0.4, cafe: 0.1 })[t] ?? 0;
  const ctx = { bestTaste: 0.8, d0: 1500 };

  it('ranks an indie matcha spot over a chain cafe for a matcha fan', () => {
    const indieMatcha = score(cand({ tags: ['cafe', 'matcha'], taste: 0.8 }), area, userWeight, ctx);
    const chainCafe = score(cand({ tags: ['cafe'], taste: 0.2, chainLocations: 533 }), area, userWeight, ctx);
    expect(indieMatcha.score).toBeGreaterThan(chainCafe.score);
  });

  it('explains itself', () => {
    const s = score(cand({ tags: ['cafe', 'matcha'] }), area, userWeight, ctx);
    expect(s.reasons).toEqual({ liked: ['matcha', 'cafe'], rarest: { tag: 'matcha', nearby: 2 }, indie: true });
  });

  it('lets distance outweigh a small edge', () => {
    const near = score(cand({ taste: 0.7, distanceM: 100 }), area, userWeight, ctx);
    const far = score(cand({ taste: 0.75, distanceM: 2000 }), area, userWeight, ctx);
    expect(near.score).toBeGreaterThan(far.score);
  });

  // Regression: with a broad profile raw cosine tops out near 0.3, and additive
  // indie/quality terms let any nearby one-off beat the best taste match.
  it('keeps taste decisive for broad profiles', () => {
    const broad = { bestTaste: 0.3, d0: 1500 };
    const match = score(cand({ taste: 0.3, distanceM: 800, tags: ['matcha'] }), area, userWeight, broad);
    const meh = score(cand({ taste: 0.02, distanceM: 50, tags: ['cafe'] }), area, userWeight, broad);
    expect(match.parts.fit).toBeCloseTo(1);
    expect(match.score).toBeGreaterThan(meh.score);
  });

  it('demotes chains and shaky listings multiplicatively, never to zero', () => {
    const base = score(cand({ taste: 0.8 }), area, userWeight, ctx).score;
    const chain = score(cand({ taste: 0.8, chainLocations: 904 }), area, userWeight, ctx).score;
    const shaky = score(cand({ taste: 0.8, confidence: 0 }), area, userWeight, ctx).score;
    expect(chain / base).toBeGreaterThan(0.6);
    expect(chain / base).toBeLessThan(0.7);
    expect(shaky / base).toBeCloseTo(0.75 / (1 - 0.25 * 0.1));
  });

  it('gives no taste credit without a profile', () => {
    expect(score(cand({ taste: 0 }), area, userWeight, { bestTaste: 0, d0: 1500 }).parts.fit).toBe(0);
  });
});

describe('mmr', () => {
  const item = (id: string, s: number, tags: string[]) => ({ id, score: s, tags });

  it('keeps score order when items are unrelated', () => {
    const out = mmr([item('a', 0.9, ['x']), item('b', 0.8, ['y']), item('c', 0.7, ['z'])], 3);
    expect(out.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('pushes near-duplicates down in favour of variety', () => {
    const out = mmr(
      [item('m1', 0.9, ['matcha', 'cafe']), item('m2', 0.88, ['matcha', 'cafe']), item('vinyl', 0.75, ['vinyl'])],
      2,
    );
    expect(out.map((i) => i.id)).toEqual(['m1', 'vinyl']);
  });
});

describe('weightsFromEnv', () => {
  it('overrides a subset', () => {
    expect(weightsFromEnv('{"taste":0.9}')).toMatchObject({ taste: 0.9, rarity: 0.3 });
  });
});
