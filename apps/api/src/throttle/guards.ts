import { ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { AuthUser } from '../auth/auth.guard';
import { rateLimited } from '../metrics/metrics';
import { clientIp } from './client-ip';
import { HOUR, LIMITS, MINUTE, USER_WINDOWS } from './limits';

/** RATE_LIMIT_ENABLED=0 turns every limit off (Helm: api.rateLimit.enabled). */
export const rateLimitEnabled = () => process.env.RATE_LIMIT_ENABLED !== '0';

const route = (ctx: ExecutionContext) => `${ctx.getClass().name}.${ctx.getHandler().name}`;

// @nestjs/throttler's guard with the parts we need changed: a 429 that carries a plain
// Retry-After header (it sets Retry-After-<name> for named limits) and the same
// number in the body, for the web app; a metric per refusal; and the on/off switch.
abstract class LimitGuard extends ThrottlerGuard {
  protected abstract readonly scope: 'ip' | 'user' | 'demo';

  protected async shouldSkip(): Promise<boolean> {
    return !rateLimitEnabled();
  }

  protected async throwThrottlingException(ctx: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    const retryAfterS = Math.max(1, detail.timeToBlockExpire);
    ctx.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(retryAfterS));
    rateLimited.inc({ scope: this.scope, route: route(ctx) });
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: 'rate_limited',
        message: `Too many requests. Try again in ${retryAfterS} s.`,
        retryAfterS,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * Per client IP, across all routes, before authentication (an APP_GUARD, so it runs
 * before the controllers' guards): requests with a bad or missing token count too.
 * The probes are exempt (@SkipThrottle({ ip: true }) on HealthController): the
 * kubelet's would all count against the node's address.
 */
@Injectable()
export class IpLimitGuard extends LimitGuard {
  protected readonly scope = 'ip';

  // ThrottlerGuard's parameters, in its order: its injection metadata is inherited by
  // position. The module's options are replaced by this guard's own.
  constructor(
    @InjectThrottlerOptions() _module: unknown,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
  ) {
    const options: ThrottlerModuleOptions = {
      throttlers: [{ name: 'ip', ...LIMITS.ip }],
      getTracker: (req) => clientIp(req as Request),
      generateKey: (_ctx, ip, name) => `rl:${name}:${ip}`,
    };
    super(options, storage, reflector);
  }
}

/**
 * Per signed-in user, per route. Goes after ClerkAuthGuard:
 * `@UseGuards(ClerkAuthGuard, UserLimitGuard)`. Every route gets the per-minute
 * window (LIMITS.user unless the route sets its own with @Throttle); the 10-second
 * and hourly windows only apply where a route opts in (limits.ts, OPT_IN_WINDOWS).
 */
@Injectable()
export class UserLimitGuard extends LimitGuard {
  protected readonly scope = 'user';

  constructor(
    @InjectThrottlerOptions() _module: unknown,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
  ) {
    const options: ThrottlerModuleOptions = {
      throttlers: [
        { name: USER_WINDOWS.minute, ...LIMITS.user },
        // Placeholders: a route that opts in sets the limit.
        { name: USER_WINDOWS.tenSeconds, limit: LIMITS.user.limit, ttl: 10_000 },
        { name: USER_WINDOWS.hour, limit: LIMITS.user.limit, ttl: 3_600_000 },
      ],
      getTracker: (req) => {
        const user = (req as Request & { user?: AuthUser }).user;
        if (!user) throw new Error('UserLimitGuard must come after ClerkAuthGuard');
        return user.id;
      },
      generateKey: (ctx, userId, name) => userKey(ctx, userId, name),
    };
    super(options, storage, reflector);
  }
}

/**
 * POST /demo/sign-in: per client IP (a minute and an hour) and one counter for all
 * clients together, on top of the global per-IP limit. `@UseGuards(DemoLimitGuard)`.
 */
@Injectable()
export class DemoLimitGuard extends LimitGuard {
  protected readonly scope = 'demo';
  constructor(
    @InjectThrottlerOptions() _module: unknown,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
  ) {
    const { minute, hour, allPerHour } = LIMITS.demoSignIn;
    const options: ThrottlerModuleOptions = {
      throttlers: [
        { name: 'demo', limit: minute, ttl: MINUTE },
        { name: 'demo-hour', limit: hour, ttl: HOUR },
        { name: 'demo-all', limit: allPerHour, ttl: HOUR, generateKey: () => 'rl:demo-all' },
      ],
      getTracker: (req) => clientIp(req as Request),
      generateKey: (_ctx, ip, name) => `rl:${name}:${ip}`,
    };
    super(options, storage, reflector);
  }
}

/** A user's counter for one route. `action` splits POST /quests/:id/:action by action. */
export function userKey(ctx: ExecutionContext, userId: string, name: string, action?: string) {
  return `rl:${name}:${route(ctx)}${action ? `:${action}` : ''}:${userId}`;
}
