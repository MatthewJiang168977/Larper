import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getOptionsToken, getStorageToken, type ThrottlerStorage } from '@nestjs/throttler';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { HealthController } from '../health/health.controller';
import { QuestsController } from '../quests/quests.controller';
import { QuestsService } from '../quests/quests.service';
import { ThrottleModule } from './throttle.module';

// The real QuestsController and HealthController with their real limit decorators
// and guards, but no database or Clerk: X-Test-User stands in for a signed-in user
// (none: 401), and the services answer with stubs. Tests for the limits only.
export async function limitTestApp(
  storage?: ThrottlerStorage,
  configure?: (app: NestExpressApplication) => void,
): Promise<{ app: INestApplication; url: string }> {
  let builder = Test.createTestingModule({
    imports: [ThrottleModule],
    controllers: [QuestsController, HealthController],
    providers: [
      {
        provide: QuestsService,
        useValue: {
          today: async () => ({ status: 'ok', quests: [] }),
          log: async () => [],
          act: async (_u: string, id: string, action: string) => ({ id, status: action }),
        },
      },
    ],
  })
    .overrideGuard(ClerkAuthGuard)
    .useValue({
      canActivate(ctx: ExecutionContext) {
        const req = ctx.switchToHttp().getRequest();
        const user = req.headers['x-test-user'];
        if (!user) throw new UnauthorizedException();
        req.user = { id: String(user), clerkId: `test_${user}` };
        return true;
      },
    });
  // Without a storage, the real one: Redis at REDIS_URL. With one, Redis is never
  // touched (the options factory, which makes the Redis client, is replaced too).
  if (storage) {
    builder = builder
      .overrideProvider(getOptionsToken())
      .useValue({ throttlers: [] })
      .overrideProvider(getStorageToken())
      .useValue(storage);
  }
  const app = (await builder.compile()).createNestApplication<NestExpressApplication>({ logger: ['error'] });
  app.set('trust proxy', 1); // as behind Traefik
  configure?.(app); // e.g. CORS, as main.ts does
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

export function hit(url: string, path: string, opts: { user?: string; method?: string; headers?: Record<string, string> } = {}) {
  return fetch(`${url}${path}`, {
    method: opts.method ?? 'GET',
    headers: { ...(opts.user ? { 'x-test-user': opts.user } : {}), ...opts.headers },
  });
}

/** Sends n requests one after another; returns their status codes. */
export async function statuses(n: number, send: () => Promise<Response>) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await send();
    await res.arrayBuffer();
    out.push(res.status);
  }
  return out;
}
