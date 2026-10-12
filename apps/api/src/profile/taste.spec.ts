import type { VibeCard } from './cards';
import { PASS_WEIGHT, seedTasteVector, topTags } from './taste';

const slots: Record<string, number> = { a: 0, b: 1, c: 2, d: 3 };
const slotOf = (t: string) => slots[t];
const tagOf = (s: number) => Object.keys(slots).find((t) => slots[t] === s);
const card = (id: string, tags: string[]): VibeCard => ({ id, title: id, blurb: '', tags });

describe('seedTasteVector', () => {
  it('needs at least one like', () => {
    expect(seedTasteVector([], [card('x', ['a'])], slotOf, 4)).toBeNull();
  });

  it('returns a unit vector', () => {
    const v = seedTasteVector([card('x', ['a', 'b']), card('y', ['c'])], [], slotOf, 4)!;
    expect(Math.hypot(...v)).toBeCloseTo(1);
  });

  it('gives each liked card equal total weight regardless of tag count', () => {
    const v = seedTasteVector([card('wide', ['a', 'b', 'c']), card('narrow', ['d'])], [], slotOf, 4)!;
    const wide = Math.hypot(v[0], v[1], v[2]);
    expect(wide).toBeCloseTo(v[3]);
  });

  it('pushes passed tags negative, more gently than likes', () => {
    const v = seedTasteVector([card('x', ['a'])], [card('y', ['b'])], slotOf, 4)!;
    expect(v[1]).toBeLessThan(0);
    expect(v[1] / v[0]).toBeCloseTo(PASS_WEIGHT);
  });

  it('rejects tags the taxonomy does not know', () => {
    expect(() => seedTasteVector([card('x', ['nope'])], [], slotOf, 4)).toThrow('unknown tag nope');
  });
});

describe('topTags', () => {
  it('orders by weight and skips non-positive slots', () => {
    expect(topTags([0.1, -0.5, 0.9, 0], tagOf)).toEqual(['c', 'a']);
  });
});
