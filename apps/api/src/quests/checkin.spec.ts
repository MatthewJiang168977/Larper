import { attemptParams, checkInLogLine, formatDistance, judgeCheckIn, rejection } from './checkin';

describe('judgeCheckIn', () => {
  it('accepts within 75 m plus the accuracy, capped at +50 m', () => {
    expect(judgeCheckIn(75).outcome).toBe('accepted'); // no accuracy: 75 m
    expect(judgeCheckIn(76).outcome).toBe('too_far');
    expect(judgeCheckIn(95, 20)).toMatchObject({ outcome: 'accepted', allowedM: 95 });
    expect(judgeCheckIn(125, 400)).toMatchObject({ outcome: 'accepted', allowedM: 125 }); // capped
  });

  it("says 'too far' when even the fix's own uncertainty doesn't reach the place", () => {
    // ±20 m fix, 300 m off: confidently elsewhere.
    expect(judgeCheckIn(300, 20).outcome).toBe('too_far');
    // ±100 m fix, 200 m off: 200 - 100 = 100 > 75.
    expect(judgeCheckIn(200, 100).outcome).toBe('too_far');
  });

  it("says 'too rough' when the fix can't tell whether you're there", () => {
    // ±300 m fix centred 200 m off: the user could be at the door.
    expect(judgeCheckIn(200, 300).outcome).toBe('too_rough');
    // Right at the edge: 200 - 125 = 75.
    expect(judgeCheckIn(200, 125).outcome).toBe('too_rough');
    // A km-wide fix (approximate location) anywhere within reach of it.
    expect(judgeCheckIn(900, 1500).outcome).toBe('too_rough');
  });

  it('never accepts more than it did before (the acceptance rule is unchanged)', () => {
    for (const a of [undefined, 0, 10, 50, 100, 500, 5000]) {
      for (const d of [0, 50, 75, 100, 125, 126, 200, 1000]) {
        const old = d <= 75 + Math.min(a ?? 0, 50);
        expect(judgeCheckIn(d, a).outcome === 'accepted').toBe(old);
      }
    }
  });
});

describe('rejection', () => {
  it('gives the distance for a confident miss', () => {
    expect(rejection(judgeCheckIn(312.4, 15))).toEqual({
      code: 'too_far',
      distanceM: 312,
      message: "You're 312 m away. Check in when you're there.",
    });
  });

  it('says the fix is too rough, with what to do about it', () => {
    expect(rejection(judgeCheckIn(200, 812.6))).toEqual({
      code: 'too_rough',
      accuracyM: 813,
      message: 'Your location is too rough to tell (±813 m). Turn on precise location or step outside, then try again.',
    });
  });
});

describe('checkInLogLine', () => {
  it('logs outcome, distance, accuracy and the allowance as JSON, with no coordinates or user id', () => {
    const line = checkInLogLine({ questId: '7', userId: '3', outcome: 'too_rough', geofence: judgeCheckIn(200.04, 300.06), demo: false });
    expect(line.startsWith('checkin {')).toBe(true);
    expect(JSON.parse(line.slice('checkin '.length))).toEqual({
      questId: '7',
      outcome: 'too_rough',
      distanceM: 200,
      accuracyM: 300.1,
      allowedM: 125,
    });
    expect(line).not.toMatch(/lat|lng|user/i);
  });

  it('logs attempts that never reached the geofence too', () => {
    expect(JSON.parse(checkInLogLine({ questId: '7', userId: '3', outcome: 'no_position', demo: false }).slice(8))).toEqual({
      questId: '7',
      outcome: 'no_position',
      distanceM: null,
      accuracyM: null,
      allowedM: null,
    });
  });
});

describe('attemptParams', () => {
  it('stores the geofence numbers unrounded, and nulls when there was no geofence', () => {
    const g = judgeCheckIn(200.04, 300.06);
    expect(attemptParams({ questId: '7', userId: '3', outcome: 'too_rough', geofence: g, demo: true })).toEqual([
      '7',
      '3',
      'too_rough',
      200.04,
      300.06,
      125,
      true,
    ]);
    expect(attemptParams({ questId: '7', userId: '3', outcome: 'no_position', demo: false })).toEqual([
      '7',
      '3',
      'no_position',
      null,
      null,
      null,
      false,
    ]);
  });
});

describe('formatDistance', () => {
  it('uses metres near the door and kilometres for long misses', () => {
    expect(formatDistance(312.4)).toBe('312 m');
    expect(formatDistance(2840)).toBe('2.8 km');
    expect(formatDistance(306_412)).toBe('306 km');
  });

  it('writes a long miss in kilometres in the rejection', () => {
    expect(rejection(judgeCheckIn(306_412, 10)).message).toBe("You're 306 km away. Check in when you're there.");
  });
});

describe('simulated demo check-ins in the log line', () => {
  it('marks a simulated check-in, and only that', () => {
    const g = judgeCheckIn(2840, 12);
    const sim = JSON.parse(checkInLogLine({ questId: '7', userId: '3', outcome: 'too_far', geofence: g, demo: true, simulated: true }).slice(8));
    expect(sim).toMatchObject({ outcome: 'too_far', simulated: true });
    const real = JSON.parse(checkInLogLine({ questId: '7', userId: '3', outcome: 'too_far', geofence: g, demo: false }).slice(8));
    expect(real).not.toHaveProperty('simulated');
  });
});
