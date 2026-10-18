import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

// Every request limit in one place. Windows are fixed (a counter per key that expires
// after the window); a key over its limit is refused for one window from then, and
// the 429 says how long in Retry-After.
//
// Per IP, on every route but the probes, before authentication: generous, since one
// IP can be a whole household or a carrier's NAT. It's there for floods and token
// guessing, not for pacing users.
// Per user, after authentication: what the app itself does, with room to spare. The
// survey poll asks for today's quests every 4 s (15/min); a check-in is one tap plus a
// few Try agains.
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const LIMITS = {
  ip: { limit: 600, ttl: MINUTE },
  // Any authenticated route without its own limit: /me, /onboarding/cards, the journal.
  user: { limit: 30, ttl: MINUTE },
  questsToday: { minute: 60, tenSeconds: 20 },
  // POST /quests/:id/complete. 6 a minute is a check-in plus five Try agains; the hourly
  // cap stops a script walking a fake position around a place.
  checkIn: { minute: 6, hour: 30 },
  // POST /quests/:id/accept and /skip: going through a deck.
  questAction: { minute: 30, hour: 600 },
  onboarding: { minute: 10 },
} as const;

// Opt-in windows: routes that use them unskip them (@SkipThrottle({ [name]: false })).
export const USER_WINDOWS = { minute: 'user', tenSeconds: 'user-10s', hour: 'user-hour' } as const;
export const OPT_IN_WINDOWS = { [USER_WINDOWS.tenSeconds]: true, [USER_WINDOWS.hour]: true };

export const actionOf = (ctx: ExecutionContext): string | undefined => {
  const action = ctx.switchToHttp().getRequest<Request>().params?.action;
  return typeof action === 'string' ? action : undefined;
};
export const isCheckIn = (ctx: ExecutionContext) => actionOf(ctx) === 'complete';
