import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_DATES, nextChange, spansOn, stateAt, validateSchedule, type OpenState, type Schedule } from './schedule';

const MIN_STATE_VECTORS = 145;

const base = (o: Partial<Schedule> = {}): Schedule => ({
  v: 1,
  tz: 'America/New_York',
  always: false,
  weekly: [],
  dates: [],
  holidays: null,
  partial: 'none',
  ...o,
});
const days = (ds: number[], from: number, to: number) => ds.map((d) => ({ d, from, to }));
const at = (iso: string) => new Date(iso);

// Mon-Sat 09:00-17:00, closed on the major holidays
const shop = base({ weekly: days([1, 2, 3, 4, 5, 6], 540, 1020), holidays: 'closed' });

describe('stateAt', () => {
  const cases: [string, Schedule | null, string, OpenState][] = [
    ['no schedule: unknown, never closed', null, '2026-07-08T16:00:00Z', 'unknown'],
    // EDT = UTC-4 (Fri 2026-07-03)
    ['EDT before opening', shop, '2026-07-03T12:59:59Z', 'closed'],
    ['EDT at opening', shop, '2026-07-03T13:00:00Z', 'open'],
    ['EDT last second', shop, '2026-07-03T20:59:59Z', 'open'],
    ['EDT at closing', shop, '2026-07-03T21:00:00Z', 'closed'],
    // EST = UTC-5 (Wed 2026-12-02)
    ['EST before opening', shop, '2026-12-02T13:59:59Z', 'closed'],
    ['EST at opening', shop, '2026-12-02T14:00:00Z', 'open'],
    ['EST at closing', shop, '2026-12-02T22:00:00Z', 'closed'],
    ['a day without spans is closed', shop, '2026-07-12T16:00:00Z', 'closed'],
    // the UTC date differs from the local date late in the evening
    ['local Friday evening is Saturday in UTC', base({ weekly: days([5], 1200, 1380) }), '2026-07-11T02:00:00Z', 'open'],
    ['late-night UTC date does not leak: Sat 02:00Z is Fri 22:00', base({ weekly: days([6], 1200, 1380) }), '2026-07-11T02:00:00Z', 'closed'],
  ];
  it.each(cases)('%s', (_n, s, iso, want) => expect(stateAt(s, at(iso))).toBe(want));

  describe('major holidays', () => {
    const openHol = { ...shop, holidays: 'open' as const };
    const nullHol = { ...shop, holidays: null };
    const rows: [string, Schedule, string, OpenState][] = [
      ['Jan 1 closed', shop, '2027-01-01T17:00:00Z', 'closed'],
      ['Jan 1 open', openHol, '2027-01-01T17:00:00Z', 'open'],
      ['Jan 1 not stated', nullHol, '2027-01-01T17:00:00Z', 'unknown'],
      ['Jul 4 2026 (Saturday) closed', shop, '2026-07-04T15:00:00Z', 'closed'],
      ['Jul 4 not stated', nullHol, '2026-07-04T15:00:00Z', 'unknown'],
      ['Dec 25 closed', shop, '2026-12-25T17:00:00Z', 'closed'],
      ['Dec 25 open', openHol, '2026-12-25T17:00:00Z', 'open'],
      ['Thanksgiving 2026-11-26 closed', shop, '2026-11-26T17:00:00Z', 'closed'],
      ['Thanksgiving 2026-11-26 not stated', nullHol, '2026-11-26T17:00:00Z', 'unknown'],
      ['3rd Thursday of Nov 2026 is no holiday', nullHol, '2026-11-19T17:00:00Z', 'open'],
      ['5th-week Thursday check: 2026-11-12 is no holiday', nullHol, '2026-11-12T17:00:00Z', 'open'],
      ['Thanksgiving 2027-11-25 closed', shop, '2027-11-25T17:00:00Z', 'closed'],
      ['Thanksgiving 2027-11-25 not stated', nullHol, '2027-11-25T17:00:00Z', 'unknown'],
      ['2027-11-18 is no holiday', nullHol, '2027-11-18T17:00:00Z', 'open'],
      ['a Thursday in another month is no holiday', nullHol, '2026-10-22T16:00:00Z', 'open'],
      ['Dec 24 is no holiday', nullHol, '2026-12-24T17:00:00Z', 'open'],
    ];
    it.each(rows)('%s', (_n, s, iso, want) => expect(stateAt(s, at(iso))).toBe(want));

    it('a date override beats the holiday rule', () => {
      const s = base({
        weekly: days([5], 540, 1020),
        holidays: 'closed',
        dates: [{ on: '2026-12-25', spans: [{ from: 600, to: 840 }] }],
      });
      expect(stateAt(s, at('2026-12-25T16:00:00Z'))).toBe('open');
      expect(stateAt(s, at('2026-12-25T14:59:59Z'))).toBe('closed');
    });

    it('holiday closed stops spans STARTING that day, not the previous night tail', () => {
      const s = base({ weekly: days([3, 4], 1080, 1560), holidays: 'closed' });
      expect(stateAt(s, at('2026-11-26T06:00:00Z'))).toBe('open'); // Thu 01:00 EST, Wednesday's tail
      expect(stateAt(s, at('2026-11-26T23:30:00Z'))).toBe('closed'); // Thu 18:30
      expect(stateAt(s, at('2026-11-27T06:00:00Z'))).toBe('closed'); // Fri 01:00: no Thursday tail
    });

    it('holidays not stated: the holiday is unknown at any minute, but an open span that is not in doubt wins', () => {
      const withTail = base({ weekly: days([3], 1080, 1560), holidays: null });
      expect(stateAt(withTail, at('2026-11-26T06:00:00Z'))).toBe('open'); // Thanksgiving 01:00, Wednesday's tail
      expect(stateAt(withTail, at('2026-11-26T15:00:00Z'))).toBe('unknown'); // Thanksgiving 10:00, outside any span
      expect(stateAt(withTail, at('2026-11-26T20:00:00Z'))).toBe('unknown'); // 15:00
      // Yesterday's holiday casts doubt only if one of its spans reaches into this minute.
      const friday = base({ weekly: days([4], 1080, 1560), holidays: null });
      // Friday 2026-11-27 01:00: Thursday (the holiday) has a tail
      expect(stateAt(friday, at('2026-11-27T06:00:00Z'))).toBe('unknown');
      const noTail = base({ weekly: days([4], 600, 900), holidays: null });
      expect(stateAt(noTail, at('2026-11-27T06:00:00Z'))).toBe('closed');
    });
  });

  describe('date overrides', () => {
    it('closed on a date', () => {
      const s = base({ weekly: days([4], 540, 1020), dates: [{ on: '2026-12-24', closed: true }] });
      expect(stateAt(s, at('2026-12-24T17:00:00Z'))).toBe('closed');
      expect(stateAt(s, at('2026-12-17T17:00:00Z'))).toBe('open');
    });
    it('a yearly rule applies every year, a specific year beats it', () => {
      const s = base({
        weekly: days([4, 5], 540, 1020),
        dates: [
          { on: '--12-24', spans: [{ from: 540, to: 900 }] },
          { on: '2026-12-24', closed: true },
        ],
      });
      expect(stateAt(s, at('2026-12-24T17:00:00Z'))).toBe('closed');
      expect(stateAt(s, at('2027-12-24T17:00:00Z'))).toBe('open');
      expect(stateAt(s, at('2027-12-24T20:00:00Z'))).toBe('closed'); // 15:00: the override ends at 900
    });
    it('replaces the weekly spans that start that date; the previous overnight tail still applies', () => {
      const closedFri = base({ weekly: days([5], 1080, 1560), dates: [{ on: '2026-07-10', closed: true }] });
      expect(stateAt(closedFri, at('2026-07-11T05:00:00Z'))).toBe('closed');
      const closedSat = base({ weekly: days([5, 6], 1080, 1560), dates: [{ on: '2026-07-11', closed: true }] });
      expect(stateAt(closedSat, at('2026-07-11T05:00:00Z'))).toBe('open'); // Friday's tail
      expect(stateAt(closedSat, at('2026-07-11T23:00:00Z'))).toBe('closed'); // Saturday 19:00
    });
  });

  describe('overnight and midnight', () => {
    const bar = base({ weekly: days([5, 6, 7], 1080, 1560), holidays: 'open' });
    it('Friday into Saturday', () => {
      expect(stateAt(bar, at('2026-07-10T21:59:59Z'))).toBe('closed');
      expect(stateAt(bar, at('2026-07-10T22:00:00Z'))).toBe('open');
      expect(stateAt(bar, at('2026-07-11T05:59:59Z'))).toBe('open');
      expect(stateAt(base({ weekly: days([5], 1080, 1560) }), at('2026-07-11T06:00:00Z'))).toBe('closed');
    });
    it('Sunday into Monday', () => {
      expect(stateAt(bar, at('2026-07-13T05:59:59Z'))).toBe('open');
      expect(stateAt(bar, at('2026-07-13T06:00:00Z'))).toBe('closed');
    });
    it('a span to 24:00 includes 23:59 and ends at midnight', () => {
      const s = base({ weekly: days([2], 0, 1440) });
      expect(stateAt(s, at('2026-07-14T04:00:00Z'))).toBe('open');
      expect(stateAt(s, at('2026-07-15T03:59:00Z'))).toBe('open');
      expect(stateAt(s, at('2026-07-15T04:00:00Z'))).toBe('closed');
    });
    it('a span to 48:00 covers the whole next day', () => {
      const s = base({ weekly: days([6], 600, 2880) });
      expect(stateAt(s, at('2026-07-13T03:59:00Z'))).toBe('open');
      expect(stateAt(s, at('2026-07-13T04:00:00Z'))).toBe('closed');
    });
  });

  it('split shifts', () => {
    const s = base({
      weekly: [
        { d: 1, from: 540, to: 720 },
        { d: 1, from: 840, to: 1200 },
      ],
    });
    expect(stateAt(s, at('2026-07-13T15:59:59Z'))).toBe('open');
    expect(stateAt(s, at('2026-07-13T16:00:00Z'))).toBe('closed');
    expect(stateAt(s, at('2026-07-13T17:59:59Z'))).toBe('closed');
    expect(stateAt(s, at('2026-07-13T18:00:00Z'))).toBe('open');
  });

  describe('always and partial', () => {
    const t = at('2026-07-13T07:00:00Z');
    it('always', () => {
      expect(stateAt(base({ always: true }), t)).toBe('open');
      expect(stateAt(base({ always: true, partial: 'additive' }), t)).toBe('open');
      expect(stateAt(base({ always: true, partial: 'restrictive' }), t)).toBe('unknown');
    });
    const wed = (partial: Schedule['partial']) => base({ weekly: days([3], 540, 1020), partial });
    const openT = at('2026-07-08T16:00:00Z');
    const closedT = at('2026-07-08T10:00:00Z');
    it.each([
      ['none', 'open', 'closed'],
      ['additive', 'open', 'unknown'],
      ['restrictive', 'unknown', 'unknown'],
    ] as const)('partial %s: open -> %s, closed -> %s', (p, o, c) => {
      expect(stateAt(wed(p), openT)).toBe(o);
      expect(stateAt(wed(p), closedT)).toBe(c);
    });
    it('a holiday with nothing stated stays unknown under any partial', () => {
      const s = base({ weekly: days([5], 540, 1020), holidays: null, partial: 'additive' });
      expect(stateAt(s, at('2026-12-25T17:00:00Z'))).toBe('unknown');
    });
  });

  describe('daylight saving is by wall clock', () => {
    it('2026-11-01: both 01:30 instants are minute 90', () => {
      const s = base({ weekly: days([7], 90, 120) });
      expect(stateAt(s, at('2026-11-01T05:30:00Z'))).toBe('open'); // 01:30 EDT
      expect(stateAt(s, at('2026-11-01T06:30:00Z'))).toBe('open'); // 01:30 EST
      expect(stateAt(s, at('2026-11-01T06:59:59Z'))).toBe('open'); // 01:59:59 EST
      expect(stateAt(s, at('2026-11-01T07:00:00Z'))).toBe('closed'); // 02:00 EST
      expect(stateAt(s, at('2026-11-01T05:29:59Z'))).toBe('closed'); // 01:29:59 EDT
    });
    it('2026-11-01: a Saturday-night span runs through the repeated hour', () => {
      const s = base({ weekly: days([6], 1080, 1560) });
      expect(stateAt(s, at('2026-11-01T05:30:00Z'))).toBe('open');
      expect(stateAt(s, at('2026-11-01T06:30:00Z'))).toBe('open');
      expect(stateAt(s, at('2026-11-01T07:00:00Z'))).toBe('closed');
    });
    it('2026-03-08: there is no 02:xx', () => {
      const s = base({ weekly: days([7], 120, 180) });
      expect(stateAt(s, at('2026-03-08T06:59:59Z'))).toBe('closed'); // 01:59:59 EST
      expect(stateAt(s, at('2026-03-08T07:00:00Z'))).toBe('closed'); // 03:00 EDT
      const after = base({ weekly: days([7], 180, 240) });
      expect(stateAt(after, at('2026-03-08T07:00:00Z'))).toBe('open');
    });
    it('2026-03-08: the Saturday-night tail ends at wall-clock 02:00, which is 03:00 EDT in effect', () => {
      const s = base({ weekly: days([6], 1080, 1560) });
      expect(stateAt(s, at('2026-03-08T06:59:59Z'))).toBe('open');
      expect(stateAt(s, at('2026-03-08T07:00:00Z'))).toBe('closed');
    });
  });
});

describe('spansOn', () => {
  it('lists the local date\'s spans as HH:MM, with the next-day flag', () => {
    const s = base({
      weekly: [
        { d: 5, from: 540, to: 720 },
        { d: 5, from: 1080, to: 1560 },
      ],
    });
    expect(spansOn(s, at('2026-07-10T16:00:00Z'))).toEqual([
      { from: '09:00', to: '12:00', nextDay: false },
      { from: '18:00', to: '02:00', nextDay: true },
    ]);
  });
  it('closing at 24:00 is shown as 24:00 on the same day (as Go does); past midnight is the next day', () => {
    expect(spansOn(base({ weekly: days([2], 480, 1440) }), at('2026-07-14T16:00:00Z'))).toEqual([
      { from: '08:00', to: '24:00', nextDay: false },
    ]);
  });
  it('uses the local date, not the UTC date', () => {
    const s = base({ weekly: [...days([5], 600, 660), ...days([6], 700, 760)] });
    expect(spansOn(s, at('2026-07-11T02:00:00Z'))).toEqual([{ from: '10:00', to: '11:00', nextDay: false }]); // Fri 22:00 local
  });
  it('honors date overrides and holidays; a closed day is []', () => {
    const s = base({
      weekly: days([4, 5], 540, 1020),
      holidays: 'closed',
      dates: [{ on: '2026-12-24', spans: [{ from: 540, to: 900 }] }],
    });
    expect(spansOn(s, at('2026-12-24T17:00:00Z'))).toEqual([{ from: '09:00', to: '15:00', nextDay: false }]);
    expect(spansOn(s, at('2026-12-25T17:00:00Z'))).toEqual([]); // Dec 25, holidays closed
    expect(spansOn(base({ weekly: days([4], 540, 1020), dates: [{ on: '2026-12-24', closed: true }] }), at('2026-12-24T17:00:00Z'))).toEqual([]);
  });
  it('holidays open or not stated show the weekly spans (state says what is known)', () => {
    const weekly = days([5], 540, 1020);
    expect(spansOn(base({ weekly, holidays: 'open' }), at('2026-12-25T17:00:00Z'))).toHaveLength(1);
    expect(spansOn(base({ weekly, holidays: null }), at('2026-12-25T17:00:00Z'))).toHaveLength(1);
    expect(spansOn(base({ weekly, holidays: 'closed' }), at('2026-12-25T17:00:00Z'))).toEqual([]);
  });
  it('always open', () => {
    expect(spansOn(base({ always: true }), at('2026-07-10T16:00:00Z'))).toEqual([{ from: '00:00', to: '24:00', nextDay: false }]);
  });
});

describe('nextChange', () => {
  const s = base({ weekly: days([1, 2, 3, 4, 5], 540, 1020), holidays: 'open' });
  it('open now: the closing time', () => {
    expect(nextChange(s, at('2026-07-08T16:00:00Z'))).toEqual({ at: '17:00', day: 'today', weekday: 'wed', to: 'closed' }); // Wed 12:00 EDT
  });
  it('closed now: the next opening, within 24 hours (tomorrow morning)', () => {
    expect(nextChange(s, at('2026-07-08T22:00:00Z'))).toEqual({ at: '09:00', day: 'tomorrow', weekday: 'thu', to: 'open' }); // Wed 18:00
  });
  it('closed now with no opening within 24 hours: null', () => {
    expect(nextChange(s, at('2026-07-10T22:00:00Z'))).toBeNull(); // Fri 18:00; Mon is two days away, Saturday has no span
  });
  it('overnight: open at 23:00, closes at 02:00', () => {
    const bar = base({ weekly: days([5], 1080, 1560) });
    expect(nextChange(bar, at('2026-07-11T03:00:00Z'))).toEqual({ at: '02:00', day: 'tomorrow', weekday: 'sat', to: 'closed' }); // Fri 23:00
    expect(nextChange(bar, at('2026-07-11T05:00:00Z'))).toEqual({ at: '02:00', day: 'today', weekday: 'sat', to: 'closed' }); // Sat 01:00
  });
  it('adjoining spans through midnight are one stretch of open time', () => {
    const t = base({ weekly: [...days([1], 1080, 1440), ...days([2], 0, 120)] });
    expect(nextChange(t, at('2026-07-14T02:00:00Z'))).toEqual({ at: '02:00', day: 'tomorrow', weekday: 'tue', to: 'closed' }); // Mon 22:00
  });
  it('split shift: the break', () => {
    const split = base({ weekly: [{ d: 1, from: 540, to: 720 }, { d: 1, from: 840, to: 1200 }] });
    expect(nextChange(split, at('2026-07-13T15:00:00Z'))).toEqual({ at: '12:00', day: 'today', weekday: 'mon', to: 'closed' });
    expect(nextChange(split, at('2026-07-13T16:30:00Z'))).toEqual({ at: '14:00', day: 'today', weekday: 'mon', to: 'open' });
  });
  it('a closed day tomorrow: the change is at midnight-bounded spans only', () => {
    const t = base({ weekly: days([1], 540, 1020), dates: [{ on: '2026-07-20', closed: true }] });
    expect(nextChange(t, at('2026-07-13T16:00:00Z'))).toEqual({ at: '17:00', day: 'today', weekday: 'mon', to: 'closed' });
  });
  it('null when always open, or when the state is unknown', () => {
    expect(nextChange(base({ always: true }), at('2026-07-08T16:00:00Z'))).toBeNull();
    expect(nextChange({ ...s, partial: 'restrictive' }, at('2026-07-08T16:00:00Z'))).toBeNull();
    expect(nextChange({ ...s, holidays: null }, at('2026-07-04T16:00:00Z'))).toBeNull();
  });
  it('null if the change would lead into an unknown holiday', () => {
    const t = base({ weekly: days([3], 540, 1440), holidays: null });
    expect(nextChange(t, at('2026-12-24T22:00:00Z'))).toBeNull(); // Thursday Dec 24 isn't it; Wed->Thu Dec 25 is
  });
  it('is by wall clock across DST', () => {
    const t = base({ weekly: days([7], 90, 120) });
    expect(nextChange(t, at('2026-11-01T05:45:00Z'))).toEqual({ at: '02:00', day: 'today', weekday: 'sun', to: 'closed' });
  });
});

describe('validateSchedule', () => {
  const good = () => JSON.parse(JSON.stringify(base({ weekly: days([1], 540, 1020), holidays: 'closed' })));
  it('accepts a valid schedule and returns it', () => {
    expect(validateSchedule(good())).toEqual(good());
    expect(
      validateSchedule({ ...good(), dates: [{ on: '--02-29', closed: true, spans: [] }, { on: '--12-24', closed: false, spans: [{ from: 1, to: 2 }] }, { on: '2026-12-25', closed: true, spans: [] }] }),
    ).not.toBeNull();
    expect(validateSchedule({ ...good(), weekly: days([1], 1000, 2880) })).not.toBeNull();
  });
  it.each<[string, (s: Record<string, unknown>) => void]>([
    ['version 2', (s) => (s.v = 2)],
    ['no version', (s) => delete s.v],
    ['unknown timezone', (s) => (s.tz = 'Mars/Olympus')],
    ['always not boolean', (s) => (s.always = 'yes')],
    ['holidays other', (s) => (s.holidays = 'maybe')],
    ['holidays not a known value', (s) => (s.holidays = 'yes')],
    ['always with weekly spans', (s) => (s.always = true)],
    ['always with holidays', (s) => ((s.always = true), (s.weekly = []), (s.holidays = 'closed'))],
    ['partial missing', (s) => delete s.partial],
    ['unsorted weekdays', (s) => (s.weekly = [{ d: 2, from: 1, to: 2 }, { d: 1, from: 1, to: 2 }])],
    ['touching weekly spans', (s) => (s.weekly = [{ d: 1, from: 100, to: 200 }, { d: 1, from: 200, to: 300 }])],
    ['dates out of order', (s) => (s.dates = [{ on: '2026-12-26', closed: true, spans: [] }, { on: '2026-12-25', closed: true, spans: [] }])],
    ['touching date spans', (s) => (s.dates = [{ on: '2026-12-25', closed: false, spans: [{ from: 1, to: 5 }, { from: 5, to: 9 }] }])],
    ['partial other', (s) => (s.partial = 'some')],
    ['weekly not an array', (s) => (s.weekly = {})],
    ['weekday 0', (s) => (s.weekly = [{ d: 0, from: 1, to: 2 }])],
    ['weekday 8', (s) => (s.weekly = [{ d: 8, from: 1, to: 2 }])],
    ['from 1440', (s) => (s.weekly = [{ d: 1, from: 1440, to: 1500 }])],
    ['from negative', (s) => (s.weekly = [{ d: 1, from: -1, to: 5 }])],
    ['to equal from', (s) => (s.weekly = [{ d: 1, from: 60, to: 60 }])],
    ['to before from', (s) => (s.weekly = [{ d: 1, from: 60, to: 30 }])],
    ['to above 2880', (s) => (s.weekly = [{ d: 1, from: 60, to: 2881 }])],
    ['fractional minutes', (s) => (s.weekly = [{ d: 1, from: 60.5, to: 90 }])],
    ['string minutes', (s) => (s.weekly = [{ d: 1, from: '60', to: 90 }])],
    ['unsorted spans in a day', (s) => (s.weekly = [{ d: 1, from: 600, to: 700 }, { d: 1, from: 100, to: 200 }])],
    ['overlapping spans in a day', (s) => (s.weekly = [{ d: 1, from: 100, to: 700 }, { d: 1, from: 600, to: 800 }])],
    ['dates not an array', (s) => (s.dates = {})],
    ['bad date format', (s) => (s.dates = [{ on: '2026-1-1', closed: true }])],
    ['impossible date', (s) => (s.dates = [{ on: '2026-02-30', closed: true }])],
    ['impossible yearly date', (s) => (s.dates = [{ on: '--04-31', closed: true }])],
    ['both closed and spans', (s) => (s.dates = [{ on: '2026-12-25', closed: true, spans: [{ from: 1, to: 2 }] }])],
    ['neither closed nor spans', (s) => (s.dates = [{ on: '2026-12-25' }])],
    ['closed false', (s) => (s.dates = [{ on: '2026-12-25', closed: false }])],
    ['empty spans', (s) => (s.dates = [{ on: '2026-12-25', closed: false, spans: [] }])],
    ['duplicate date', (s) => (s.dates = [{ on: '2026-12-25', closed: true }, { on: '2026-12-25', closed: true }])],
  ])('rejects: %s', (_n, mutate) => {
    const s = good();
    mutate(s);
    expect(validateSchedule(s)).toBeNull();
  });
  it.each([null, undefined, 'x', 3, [], true])('rejects a non-object: %p', (x) => {
    expect(validateSchedule(x)).toBeNull();
  });
  it('takes what Go emits: every key present, both date-rule keys, and missing optional keys as empty', () => {
    const goShape = { v: 1, tz: 'America/New_York', always: true, weekly: [], dates: [], holidays: null, partial: 'none' };
    expect(validateSchedule(goShape)).toEqual(goShape);
    const minimal = { v: 1, tz: 'America/New_York', partial: 'none' };
    expect(validateSchedule(minimal)).toEqual({ ...minimal, always: false, weekly: [], dates: [], holidays: null });
  });
  it('an invalid schedule is no schedule: unknown, never closed', () => {
    expect(stateAt(validateSchedule({ v: 1 }), at('2026-07-08T16:00:00Z'))).toBe('unknown');
  });
});

describe('shared test vectors (testdata/vectors.json)', () => {
  // The Go package's canonical file, copied verbatim (workers/internal/hours/testdata/vectors.json).
  it('is the full canonical file, not a smaller one swapped in', () => {
    const f = JSON.parse(readFileSync(join(__dirname, 'testdata', 'vectors.json'), 'utf8')) as { state: unknown[] };
    if (f.state.length < MIN_STATE_VECTORS) {
      throw new Error(
        `vectors.json has ${f.state.length} state vectors, fewer than the ${MIN_STATE_VECTORS} of the Go package's file: copy workers/internal/hours/testdata/vectors.json over it verbatim`,
      );
    }
  });
  const file = JSON.parse(readFileSync(join(__dirname, 'testdata', 'vectors.json'), 'utf8')) as {
    v: number;
    state: { name: string; schedule: unknown; at: string; expect: OpenState }[];
  };
  it('is version 1', () => expect(file.v).toBe(1));
  it.each(file.state.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const schedule = v.schedule === null ? null : validateSchedule(v.schedule);
    if (v.schedule !== null) expect(schedule).not.toBeNull(); // a vector's schedule is meant to be valid
    expect(stateAt(schedule, new Date(v.at))).toBe(v.expect);
  });
});

describe('the schedules in the shared parse vectors', () => {
  const file = JSON.parse(readFileSync(join(__dirname, 'testdata', 'vectors.json'), 'utf8')) as {
    parse: { name: string; schedule: unknown; error?: boolean }[];
  };
  const withSchedule = file.parse.filter((p) => p.schedule && !p.error);
  it.each(withSchedule.map((p) => [p.name, p.schedule] as const))('Go emits a schedule this reader accepts: %s', (_n, schedule) => {
    expect(validateSchedule(schedule)).not.toBeNull();
  });
});

describe('nextChange across days', () => {
  it('names the day: a closed place that opens tomorrow says tomorrow, with the weekday', () => {
    const t = base({ weekly: days([1, 2, 3, 4, 5], 540, 1020) });
    const c = nextChange(t, at('2026-07-08T22:00:00Z')); // Wed 18:00
    expect(c).toEqual({ at: '09:00', day: 'tomorrow', weekday: 'thu', to: 'open' });
  });
  it('the same clock time today and tomorrow are told apart', () => {
    const t = base({ weekly: days([1, 2, 3, 4, 5], 540, 1020) });
    expect(nextChange(t, at('2026-07-08T11:00:00Z'))).toMatchObject({ at: '09:00', day: 'today' }); // Wed 07:00
    expect(nextChange(t, at('2026-07-08T22:00:00Z'))).toMatchObject({ at: '09:00', day: 'tomorrow' }); // Wed 18:00
  });
  it('is by New York days, not UTC days: Sat 22:00 EDT is Sunday in UTC', () => {
    const t = base({ weekly: days([7], 540, 1020) });
    expect(nextChange(t, at('2026-07-12T02:00:00Z'))).toEqual({ at: '09:00', day: 'tomorrow', weekday: 'sun', to: 'open' });
  });
});

describe('the dated exceptions cap', () => {
  const dateRules = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ on: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), closed: true }));
  const sched = (n: number) => ({ ...base(), dates: dateRules(n) });
  it('accepts exactly MAX_DATES entries', () => {
    expect(MAX_DATES).toBe(366);
    expect(validateSchedule(sched(MAX_DATES))?.dates).toHaveLength(MAX_DATES);
  });
  it('rejects one more, as it rejects any other invalid schedule (no schedule at all)', () => {
    expect(validateSchedule(sched(MAX_DATES + 1))).toBeNull();
    expect(validateSchedule(sched(5000))).toBeNull();
  });
});
