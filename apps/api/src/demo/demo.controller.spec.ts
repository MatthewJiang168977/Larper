import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getOptionsToken, getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import { LIMITS } from '../throttle/limits';
import { ThrottleModule } from '../throttle/throttle.module';
import { ClerkApiError, type ClerkApi } from './clerk-api';
import { TICKET_TTL_S, type ClerkUser } from './demo-account';
import { DEMO, DemoController, type Demo } from './demo.controller';

// POST /demo/sign-in with its real guards, limits counted in memory, and Clerk faked.
// Each test starts its own app (a cold one can take a few seconds).
jest.setTimeout(30_000);
const USER = 'user_demo123';
const cfg = { userId: USER, email: 'demo@example.test' };

type Call = { method: string; path: string; body?: unknown };
function fakeClerk(user: Partial<ClerkUser> = {}, fail?: number) {
  const calls: Call[] = [];
  const clerk: ClerkApi = async <T>(method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (fail) throw new ClerkApiError(fail, `${method} ${path}`);
    if (method === 'GET') return { id: USER, two_factor_enabled: false, locked: false, ...user } as T;
    if (path === '/sign_in_tokens') return { token: `ticket-${calls.length}` } as T;
    return {} as T;
  };
  return { clerk, calls };
}

async function app(demo: Demo): Promise<{ app: INestApplication; url: string }> {
  const mod = await Test.createTestingModule({
    imports: [ThrottleModule],
    controllers: [DemoController],
    providers: [{ provide: DEMO, useValue: demo }],
  })
    .overrideProvider(getOptionsToken())
    .useValue({ throttlers: [] })
    .overrideProvider(getStorageToken())
    .useValue(new ThrottlerStorageService())
    .compile();
  const a = mod.createNestApplication<NestExpressApplication>({ logger: false });
  a.set('trust proxy', 1); // as behind Traefik
  await a.listen(0, '127.0.0.1');
  return { app: a, url: await a.getUrl() };
}

let ip = 0;
const fromNewIp = () => ({ 'x-forwarded-for': `198.51.100.${(++ip % 250) + 1}` });
const signIn = (url: string, headers: Record<string, string>, body?: unknown) =>
  fetch(`${url}/demo/sign-in`, {
    method: 'POST',
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

describe('POST /demo/sign-in', () => {
  it("returns a short-lived sign-in token for the configured user only, whatever the body says", async () => {
    const { clerk, calls } = fakeClerk();
    const { app: a, url } = await app({ clerk, cfg });
    try {
      const res = await signIn(url, fromNewIp(), { user_id: 'user_someoneelse' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ticket: 'ticket-2' });
      expect(calls).toEqual([
        { method: 'GET', path: `/users/${USER}`, body: undefined },
        { method: 'POST', path: '/sign_in_tokens', body: { user_id: USER, expires_in_seconds: TICKET_TTL_S } },
      ]);
    } finally {
      await a.close();
    }
  });

  it('takes off two-step verification and a lockout first: either would stop the next visitor', async () => {
    const { clerk, calls } = fakeClerk({ two_factor_enabled: true, locked: true });
    const { app: a, url } = await app({ clerk, cfg });
    try {
      expect((await signIn(url, fromNewIp())).status).toBe(200);
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        `GET /users/${USER}`,
        `DELETE /users/${USER}/mfa`,
        `POST /users/${USER}/unlock`,
        'POST /sign_in_tokens',
      ]);
    } finally {
      await a.close();
    }
  });

  it("is 404 where the demo is off, and 503 (no details) when Clerk fails", async () => {
    const off = await app(null);
    try {
      expect((await signIn(off.url, fromNewIp())).status).toBe(404);
    } finally {
      await off.app.close();
    }
    const { clerk } = fakeClerk({}, 500);
    const broken = await app({ clerk, cfg });
    try {
      const res = await signIn(broken.url, fromNewIp());
      expect(res.status).toBe(503);
      expect(JSON.stringify(await res.json())).not.toContain('Clerk');
    } finally {
      await broken.app.close();
    }
  });

  it(`allows ${LIMITS.demoSignIn.minute} a minute per IP, then 429 with Retry-After; another IP is unaffected`, async () => {
    const { clerk } = fakeClerk();
    const { app: a, url } = await app({ clerk, cfg });
    try {
      const headers = fromNewIp();
      for (let i = 0; i < LIMITS.demoSignIn.minute; i++) expect((await signIn(url, headers)).status).toBe(200);
      const res = await signIn(url, headers);
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await signIn(url, fromNewIp())).status).toBe(200);
    } finally {
      await a.close();
    }
  });

  it(`caps everyone together at ${LIMITS.demoSignIn.allPerHour} an hour`, async () => {
    const { clerk } = fakeClerk();
    const { app: a, url } = await app({ clerk, cfg });
    try {
      // Spread over enough addresses that no per-IP window is reached.
      const perIp = LIMITS.demoSignIn.minute;
      let sent = 0;
      while (sent < LIMITS.demoSignIn.allPerHour) {
        const headers = fromNewIp();
        for (let i = 0; i < perIp && sent < LIMITS.demoSignIn.allPerHour; i++, sent++) {
          expect((await signIn(url, headers)).status).toBe(200);
        }
      }
      expect((await signIn(url, { 'x-forwarded-for': '192.0.2.200' })).status).toBe(429);
    } finally {
      await a.close();
    }
  });
});
