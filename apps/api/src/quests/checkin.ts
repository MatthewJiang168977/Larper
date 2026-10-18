// The check-in geofence, kept pure so the rule can be tested on its own.
//
// A check-in counts within CHECKIN_RADIUS_M of the place, plus the phone's reported GPS
// accuracy capped at MAX_ACCURACY_BONUS_M (so a vague fix can't check in from blocks
// away). When it fails, the message depends on whether the fix could tell: if its own
// uncertainty circle still reaches the place's radius, the user may well be there and
// the fix is too rough to say; otherwise they're confidently somewhere else.
// A three-tier alternative (accept rough fixes as "unverified" at reduced weight) is
// written up in docs/decisions/0002-checkin-accuracy-tiers.md, deferred until the
// check-in log below shows real distances and accuracies.

export const CHECKIN_RADIUS_M = 75;
export const MAX_ACCURACY_BONUS_M = 50;

export type GeofenceOutcome = 'accepted' | 'too_far' | 'too_rough';

export interface Geofence {
  outcome: GeofenceOutcome;
  distanceM: number;
  accuracyM: number | null;
  allowedM: number;
}

export function judgeCheckIn(distanceM: number, accuracyM?: number): Geofence {
  const allowedM = CHECKIN_RADIUS_M + Math.min(accuracyM ?? 0, MAX_ACCURACY_BONUS_M);
  const base = { distanceM, accuracyM: accuracyM ?? null, allowedM };
  if (distanceM <= allowedM) return { outcome: 'accepted', ...base };
  const couldBeThere = accuracyM !== undefined && distanceM - accuracyM <= CHECKIN_RADIUS_M;
  return { outcome: couldBeThere ? 'too_rough' : 'too_far', ...base };
}

/** The 422 body for a rejected check-in: a message for people, a code for the client. */
export function rejection(g: Geofence) {
  if (g.outcome === 'too_rough') {
    return {
      code: 'too_rough' as const,
      accuracyM: Math.round(g.accuracyM ?? 0),
      message:
        `Your location is too rough to tell (±${Math.round(g.accuracyM ?? 0)} m). ` +
        'Turn on precise location or step outside, then try again.',
    };
  }
  return {
    code: 'too_far' as const,
    distanceM: Math.round(g.distanceM),
    message: `You're ${Math.round(g.distanceM)} m away. Check in when you're there.`,
  };
}

/** Every check-in attempt's final outcome, as logged. */
export type CheckInOutcome = GeofenceOutcome | 'no_position' | 'not_found' | 'conflict' | 'error';

export interface CheckInAttempt {
  questId: string;
  userId: string;
  outcome: CheckInOutcome;
  geofence?: Geofence;
}

// One line per attempt, JSON after a fixed prefix, so `grep checkin` + a JSON parser
// gives distance / accuracy / outcome over time. No coordinates: distance to the place
// is all the rule needs, and it says nothing about where the user lives.
export function checkInLogLine(a: CheckInAttempt): string {
  const g = a.geofence;
  return `checkin ${JSON.stringify({
    questId: a.questId,
    userId: a.userId,
    outcome: a.outcome,
    distanceM: g ? Math.round(g.distanceM * 10) / 10 : null,
    accuracyM: g?.accuracyM != null ? Math.round(g.accuracyM * 10) / 10 : null,
    allowedM: g ? Math.round(g.allowedM * 10) / 10 : null,
  })}`;
}
