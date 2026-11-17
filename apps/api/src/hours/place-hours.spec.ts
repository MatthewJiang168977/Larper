import { chooseSchedules, confirmationBucket, MIN_HOURS_CONFIDENCE, type ScheduleFact } from './place-hours';

const at = (iso: string) => new Date(iso);

describe('confirmationBucket (New York time)', () => {
  const rows: [string, string, string, string][] = [
    // EDT (UTC-4), Wednesday 2026-07-15
    ['04:59 is still night', '2026-07-15T08:59:59Z', 'wed', 'night'],
    ['05:00 is morning', '2026-07-15T09:00:00Z', 'wed', 'morning'],
    ['11:59 is morning', '2026-07-15T15:59:59Z', 'wed', 'morning'],
    ['12:00 is afternoon', '2026-07-15T16:00:00Z', 'wed', 'afternoon'],
    ['16:59 is afternoon', '2026-07-15T20:59:59Z', 'wed', 'afternoon'],
    ['17:00 is evening', '2026-07-15T21:00:00Z', 'wed', 'evening'],
    ['21:59 is evening', '2026-07-16T01:59:59Z', 'wed', 'evening'],
    ['22:00 is night', '2026-07-16T02:00:00Z', 'wed', 'night'],
    ['00:30 belongs to the local day', '2026-07-19T04:30:00Z', 'sun', 'night'],
    // EST (UTC-5), Tuesday 2026-12-01
    ['EST 04:59 is night', '2026-12-01T09:59:59Z', 'tue', 'night'],
    ['EST 05:00 is morning', '2026-12-01T10:00:00Z', 'tue', 'morning'],
    ['EST 22:00 is night', '2026-12-02T03:00:00Z', 'tue', 'night'],
    // 2026-11-01, clocks go back at 06:00Z (02:00 EDT -> 01:00 EST)
    ['the repeated hour is night: first 01:30', '2026-11-01T05:30:00Z', 'sun', 'night'],
    ['the repeated hour is night: second 01:30', '2026-11-01T06:30:00Z', 'sun', 'night'],
    ['fall back day: 04:59 EST is night', '2026-11-01T09:59:59Z', 'sun', 'night'],
    ['fall back day: 05:00 EST is morning', '2026-11-01T10:00:00Z', 'sun', 'morning'],
    ['the evening before the change is Saturday', '2026-11-01T01:30:00Z', 'sat', 'evening'],
    // 2026-03-08, clocks go forward at 07:00Z (02:00 EST -> 03:00 EDT)
    ['spring forward day: 04:59 EDT is night', '2026-03-08T08:59:59Z', 'sun', 'night'],
    ['spring forward day: 05:00 EDT is morning', '2026-03-08T09:00:00Z', 'sun', 'morning'],
    ['spring forward day: 12:00 EDT is afternoon', '2026-03-08T16:00:00Z', 'sun', 'afternoon'],
  ];
  it.each(rows)('%s', (_n, iso, day, part) => {
    expect(confirmationBucket(at(iso))).toEqual({ day, part });
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
