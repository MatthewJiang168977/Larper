import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_WEIGHTS } from '../quests/scoring';
import { evaluate, EvalResult, PROFILES, regressions } from './eval';
import { fixture } from './fixture';
import { parseGoldenCsv, toGoldenCsv } from './golden';
import { VIBE_CARDS } from '../profile/cards';

// The regression gate CI runs: the ranker on the synthetic fixture against the committed
// baseline (docs/eval/baseline.json). If a scoring change is meant to move these numbers,
// re-write the baseline with `pnpm --filter @larper/api eval -- --update-baseline` and say
// why in the PR.
const ROOT = join(__dirname, '../../../..');
const baseline = JSON.parse(readFileSync(join(ROOT, 'docs/eval/baseline.json'), 'utf8')) as EvalResult;

describe('offline eval', () => {
  const { places, golden } = fixture();

  it('does not regress against the committed baseline', () => {
    const result = evaluate(places, golden);
    expect(regressions(result, baseline)).toEqual([]);
    expect(result.runs).toBe(baseline.runs);
  });

  it('has twenty profiles, of real cards', () => {
    expect(PROFILES).toHaveLength(20);
    for (const id of PROFILES.flat()) expect(VIBE_CARDS.map((c) => c.id)).toContain(id);
  });

  it('is sensitive to the scoring: dropping the chain and confidence penalties fails the gate', () => {
    const worse = evaluate(places, golden, { ...DEFAULT_WEIGHTS, taste: 0.7, rarity: 0, indie: -1, quality: -1 });
    expect(regressions(worse, baseline)).not.toEqual([]);
  });

  it('fails past the margins and not within them', () => {
    const base = { runs: 10, top1Great: 0.4, top3Great: 0.7, badOrClosed: 0.1, rated: 1 };
    expect(regressions({ ...base, top1Great: 0.35, badOrClosed: 0.12 }, base)).toEqual([]);
    expect(regressions({ ...base, top1Great: 0.34 }, base)).toHaveLength(1);
    expect(regressions({ ...base, badOrClosed: 0.13 }, base)).toHaveLength(1);
    expect(regressions({ ...base, runs: 0 }, base)).not.toEqual([]);
  });
});

describe('golden set', () => {
  it('starts as a header only', () => {
    expect(parseGoldenCsv(readFileSync(join(ROOT, 'data/golden-places.csv'), 'utf8')).size).toBeGreaterThanOrEqual(0);
    expect(parseGoldenCsv('overture_id,rating,note,rated_at\n')).toEqual(new Map());
  });

  it('round-trips notes with commas and quotes, and refuses a bad file', () => {
    const csv = toGoldenCsv([{ overtureId: 'a', rating: 'great', note: 'go "late", after 9', ratedAt: '2026-11-26' }]);
    expect(parseGoldenCsv(csv)).toEqual(new Map([['a', 'great']]));
    expect(() => parseGoldenCsv('id,rating\n')).toThrow('header');
    expect(() => parseGoldenCsv('overture_id,rating,note,rated_at\na,superb,,2026-11-26\n')).toThrow('row 2');
    expect(() => parseGoldenCsv('overture_id,rating,note,rated_at\na,bad,,d\na,fine,,d\n')).toThrow('twice');
  });
});
