import { BadRequestException } from '@nestjs/common';
import { QuestsService } from '../quests/quests.service';
import { chooseSchedules, confirmationRecency, MIN_CONFIRMATIONS, MIN_HOURS_CONFIDENCE, openConfirmations, requireObserver, type ScheduleFact } from './place-hours';

const at = (iso: string) => new Date(iso);

describe('confirmationRecency', () => {
  const NOW = at('2026-07-15T16:00:00Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const D = 86_400_000;
  const rows: [string, Date, string][] = [
    ['just now', ago(0), 'this_week'],
    ['a few hours ago', ago(3 * 3600_000), 'this_week'],
    ['exactly 7 days is still this week', ago(7 * D), 'this_week'],
    ['7 days and a second is this month', ago(7 * D + 1000), 'this_month'],
    ['exactly 30 days is still this month', ago(30 * D), 'this_month'],
    ['30 days and a second is a while ago', ago(30 * D + 1000), 'a_while_ago'],
    ['179 days is a while ago', ago(179 * D), 'a_while_ago'],
    ['a time ahead of now (clock skew) is this week', ago(-5 * 60_000), 'this_week'],
  ];
  it.each(rows)('%s', (_n, when, want) => expect(confirmationRecency(when, NOW)).toBe(want));
});

describe('openConfirmations: nothing below 3 people', () => {
  const NOW = at('2026-07-15T16:00:00Z');
  const last = at('2026-07-14T12:00:00Z');
  it.each([0, 1, 2])('%i people: null, so not the count and not the time', (n) => {
    expect(openConfirmations(n, last, NOW)).toBeNull();
  });
  it('3 people: the count and a coarse recency, and nothing else', () => {
    const c = openConfirmations(3, last, NOW);
    expect(c).toEqual({ count: 3, last: 'this_week' });
    expect(JSON.stringify(c)).toBe('{"count":3,"last":"this_week"}');
  });
  it('more people, an older newest answer', () => {
    expect(openConfirmations(12, at('2026-05-01T12:00:00Z'), NOW)).toEqual({ count: 12, last: 'a_while_ago' });
  });
  it('null for no row or no time', () => {
    expect(openConfirmations(null, null, NOW)).toBeNull();
    expect(openConfirmations(5, null, NOW)).toBeNull();
    expect(MIN_CONFIRMATIONS).toBe(3);
  });
});

describe('chooseSchedules', () => {
  const valid = { v: 1, tz: 'America/New_York', always: true, weekly: [], dates: [], holidays: null, partial: 'none' };
  const fact = (o: Partial<ScheduleFact> & { id: string }): ScheduleFact => ({
    placeId: '1',
    service: 'regular',
    source: 'osm',
    sourceUrl: null,
    fetchedAt: new Date('2026-06-01T00:00:00Z'),
    confidence: 0.8,
    schedule: valid,
    ...o,
  });
  const pick = (facts: ScheduleFact[], service: ScheduleFact['service'] = 'regular') =>
    chooseSchedules(facts).get('1')?.get(service)?.fact.id;

  it('the highest confidence wins, then the newest fetch, then the higher id', () => {
    expect(pick([fact({ id: '1', confidence: 0.6 }), fact({ id: '2', confidence: 0.9 })])).toBe('2');
    expect(pick([fact({ id: '1' }), fact({ id: '2', fetchedAt: new Date('2026-07-01T00:00:00Z') })])).toBe('2');
    expect(pick([fact({ id: '9' }), fact({ id: '10' })])).toBe('10');
    expect(pick([fact({ id: '10' }), fact({ id: '9' })])).toBe('10');
  });
  it('facts below the floor are ignored; the floor itself counts', () => {
    expect(MIN_HOURS_CONFIDENCE).toBe(0.5);
    expect(pick([fact({ id: '1', confidence: 0.49 })])).toBeUndefined();
    expect(pick([fact({ id: '1', confidence: 0.5 })])).toBe('1');
  });
  it('an invalid schedule is skipped, so the next valid one stands in', () => {
    expect(pick([fact({ id: '1', confidence: 0.99, schedule: { v: 1 } }), fact({ id: '2', confidence: 0.6 })])).toBe('2');
    expect(pick([fact({ id: '1', schedule: null })])).toBeUndefined();
  });
  it('services are chosen on their own', () => {
    const facts = [fact({ id: '1' }), fact({ id: '2', service: 'kitchen' })];
    expect(pick(facts, 'kitchen')).toBe('2');
    expect(pick(facts, 'bar')).toBeUndefined();
  });
});

describe('requireObserver: an observation always has a user', () => {
  it.each([null, undefined, '', '0', 'abc', '1; DROP', 12, ' 7'])('refuses %j', (v) => {
    expect(() => requireObserver(v)).toThrow(BadRequestException);
  });
  it('passes a numeric user id through', () => {
    expect(requireObserver('42')).toBe('42');
  });
  it('QuestsService.wasOpen refuses before touching the database', async () => {
    const pg = { query: jest.fn() };
    const svc = new QuestsService(pg as never, {} as never, {} as never, {} as never);
    await expect(svc.wasOpen('', '5', 'yes')).rejects.toBeInstanceOf(BadRequestException);
    expect(pg.query).not.toHaveBeenCalled();
  });
});
