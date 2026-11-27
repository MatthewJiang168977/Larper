import { readFileSync } from 'fs';
import { join } from 'path';
import { applyReliability, HALF_LIFE_DAYS, PRIOR_FAILURE, PRIOR_SUCCESS, reliabilityScore } from './reliability';

const NOW = new Date('2026-11-26T12:00:00Z');
const row = (successes: number, failures: number, suspendedAt: Date | null = null, asOf = NOW) => ({ successes, failures, asOf, suspendedAt });

describe('reliability', () => {
  it('uses the constants of the worker that writes the table', () => {
    const go = readFileSync(join(__dirname, '../../../../workers/internal/reliability/reliability.go'), 'utf8');
    const constant = (name: string) => Number(new RegExp(`\\b${name}\\s*=\\s*([0-9.]+)`).exec(go)?.[1]);
    expect([constant('PriorSuccess'), constant('PriorFailure'), constant('HalfLifeDays')]).toEqual([
      PRIOR_SUCCESS,
      PRIOR_FAILURE,
      HALF_LIFE_DAYS,
    ]);
  });

  it('is the prior with no evidence and returns towards it as evidence ages', () => {
    expect(reliabilityScore(row(0, 0), NOW)).toBeCloseTo(0.8);
    expect(reliabilityScore(row(0, 1), NOW)).toBeCloseTo(4 / 6);
    const halfLifeAgo = new Date(NOW.getTime() - 60 * 86_400_000);
    expect(reliabilityScore(row(0, 1, null, halfLifeAgo), NOW)).toBeCloseTo(4 / 5.5);
  });

  it('excludes the suspended, demotes the doubtful, and never promotes', () => {
    const places = ['1', '2', '3', '4'].map((id) => ({ id, score: 1 }));
    const out = applyReliability(
      places,
      new Map([
        ['1', row(0, 0, NOW)],
        ['2', row(0, 1)],
        ['3', row(20, 0)],
      ]),
      NOW,
    );
    expect(out.map((p) => p.id)).toEqual(['2', '3', '4']);
    expect(out[0].score).toBeCloseTo(4 / 6 / 0.8);
    expect(out[1].score).toBe(1);
    expect(out[2].score).toBe(1);
  });
});
