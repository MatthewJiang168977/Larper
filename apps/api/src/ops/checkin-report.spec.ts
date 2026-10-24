import { Attempt, rate, summarize, wilson } from './checkin-report';

let t = Date.parse('2026-10-25T12:00:00Z');
const a = (questId: string | null, outcome: string, over: Partial<Attempt> = {}): Attempt => ({
  questId,
  outcome,
  distanceM: 40,
  accuracyM: 20,
  demo: false,
  createdAt: new Date((t += 60_000)),
  ...over,
});

describe('wilson / rate', () => {
  it('gives a wide interval for a handful and a tight one for many', () => {
    const [lo3, hi3] = wilson(1, 3);
    expect(lo3).toBeCloseTo(0.0615, 3);
    expect(hi3).toBeCloseTo(0.7923, 3);
    const [lo, hi] = wilson(500, 1000);
    expect(hi - lo).toBeLessThan(0.07);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });

  it('always shows the count next to the percentage', () => {
    expect(rate(1, 3)).toBe('1 of 3 = 33% (95% CI 6%-79%)');
    expect(rate(0, 0)).toBe('0 of 0');
  });
});

describe('summarize', () => {
  it('leads with the sample size and flags a small one before any rate', () => {
    const out = summarize([a('1', 'accepted'), a('2', 'too_far', { distanceM: 900 })], 90);
    expect(out[1]).toMatch(/^Sample: 2 real attempts on 2 quests, 2026-10-25 to 2026-10-25\. Demo account: 0 attempts/);
    expect(out[2]).toMatch(/^SMALL SAMPLE/);
    expect(out.findIndex((l) => l.includes('%'))).toBeGreaterThan(2);
  });

  it('leaves the demo account out of every figure, but says how many it had', () => {
    const out = summarize([a('1', 'accepted'), a('9', 'too_far', { demo: true }), a('9', 'too_far', { demo: true })], 90);
    expect(out[1]).toContain('1 real attempts on 1 quests');
    expect(out[1]).toContain('Demo account: 2 attempts (not counted)');
    expect(out.join('\n')).not.toContain('too_far');
  });

  it('drops the small-sample warning once there are enough attempts and quests', () => {
    const many = Array.from({ length: 30 }, (_, i) => a(String(i % 15), 'accepted'));
    expect(summarize(many, 90).some((l) => l.startsWith('SMALL SAMPLE'))).toBe(false);
  });

  it('counts rough fixes, how they ended, and recoveries per quest in time order', () => {
    const out = summarize(
      [
        a('1', 'too_rough', { accuracyM: 400 }),
        a('1', 'accepted', { accuracyM: 30, distanceM: 50 }),
        a('2', 'accepted', { accuracyM: 25, distanceM: 70 }),
        a('2', 'too_rough', { accuracyM: 300 }), // accepted came first: not a recovery
        a('3', 'too_rough', { accuracyM: 900 }),
        a('4', 'too_far', { accuracyM: 150, distanceM: 800 }),
        a(null, 'not_found', { accuracyM: null, distanceM: null }),
      ],
      90,
    ).join('\n');
    expect(out).toContain('Rough fixes (accuracy over 100 m), of attempts that reported accuracy:\n  4 of 6 = 67%');
    expect(out).toContain('of those, ended too_rough: 3 of 4 = 75%');
    expect(out).toContain('recovered (accepted later): 1 of 3 = 33%');
    expect(out).toContain('Accepted check-ins, distance from the place (n = 2):\n  median 60 m');
    expect(out).toContain('with 2 values, p75 and p90 are close to just the largest ones');
  });

  it('says there is nothing yet, without rates, when there are no real attempts', () => {
    const out = summarize([a('9', 'too_far', { demo: true })], 21);
    expect(out[0]).toContain('last 21 days');
    expect(out[1]).toContain('0 real attempts on 0 quests, - to -');
    expect(out).toHaveLength(3);
  });
});
