import { checkInLogLine, judgeCheckIn, rejection } from './checkin';

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
    const line = checkInLogLine({ questId: '7', userId: '3', outcome: 'too_rough', geofence: judgeCheckIn(200.04, 300.06) });
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
    expect(JSON.parse(checkInLogLine({ questId: '7', userId: '3', outcome: 'no_position' }).slice(8))).toEqual({
      questId: '7',
      outcome: 'no_position',
      distanceM: null,
      accuracyM: null,
      allowedM: null,
    });
  });
});
