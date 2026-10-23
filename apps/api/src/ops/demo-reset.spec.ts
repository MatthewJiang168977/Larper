import { DEMO_TASTE, isDemoUser } from '../demo/demo-account';
import { VIBE_CARDS } from '../profile/cards';
import { TAG_DIMS } from '../profile/tags.service';
import { demoTasteVector } from './demo-reset';

// Slots for every tag the cards use, as the tags table would give them.
const slots = new Map([...new Set(VIBE_CARDS.flatMap((c) => c.tags))].map((t, i) => [t, i]));

describe('the demo taste baseline', () => {
  it('names real cards, likes at least one, and passes none it likes', () => {
    const ids = new Set(VIBE_CARDS.map((c) => c.id));
    expect(DEMO_TASTE.liked.length).toBeGreaterThan(0);
    for (const id of [...DEMO_TASTE.liked, ...DEMO_TASTE.passed]) expect(ids.has(id)).toBe(true);
    expect(DEMO_TASTE.liked.filter((id) => DEMO_TASTE.passed.includes(id))).toEqual([]);
  });

  it('is a unit vector weighted on the liked cards’ tags only', () => {
    const vec = demoTasteVector(slots);
    expect(vec).toHaveLength(TAG_DIMS);
    expect(Math.hypot(...vec)).toBeCloseTo(1, 6);
    const likedTags = new Set(VIBE_CARDS.filter((c) => DEMO_TASTE.liked.includes(c.id)).flatMap((c) => c.tags));
    slots.forEach((slot, tag) => expect(vec[slot] > 0).toBe(likedTags.has(tag)));
  });

  it('refuses a taxonomy missing one of its tags', () => {
    const partial = new Map(slots);
    partial.delete(VIBE_CARDS.find((c) => c.id === DEMO_TASTE.liked[0])!.tags[0]);
    expect(() => demoTasteVector(partial)).toThrow(/unknown tag/);
  });
});

describe('isDemoUser', () => {
  it('is the configured user only, and nobody when the demo is off', () => {
    expect(isDemoUser('user_demo', { DEMO_CLERK_USER_ID: 'user_demo' })).toBe(true);
    expect(isDemoUser('user_other', { DEMO_CLERK_USER_ID: 'user_demo' })).toBe(false);
    expect(isDemoUser('user_demo', {})).toBe(false);
    expect(isDemoUser('', { DEMO_CLERK_USER_ID: '' })).toBe(false);
  });
});
