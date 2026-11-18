import { ExecutionContext, ForbiddenException, INestApplication, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorageService, getOptionsToken, getStorageToken } from '@nestjs/throttler';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { FailOpenStorage } from '../throttle/fail-open.storage';
import { UserLimitGuard } from '../throttle/guards';
import { LIMITS, MINUTE, USER_WINDOWS } from '../throttle/limits';
import { ThrottleModule } from '../throttle/throttle.module';
import { DEMO_REFUSAL, DataDeletionService } from './data-deletion';
import { DataExportService } from './data-export';
import { MeDataController } from './me-data.controller';
import { PRIVACY_DELETES, type PrivacyDeletes } from './privacy-deletes';

// GET /me/export, DELETE /me/history and DELETE /me through the real controller and its
// real guards (the services are stubs; Clerk is replaced by X-Test-User, as in
// saved-places.controller.spec.ts).
describe('MeDataController', () => {
  // Two apps over the same stubs: the delete routes switched on (PRIVACY_DELETES=history,
  // the main one) and left off (the default).
  let app: INestApplication;
  let url: string;
  let offApp: INestApplication;
  let offUrl: string;
  const exportFn = jest.fn();
  const deleteHistory = jest.fn();
  const deleteAccount = jest.fn();
  const storage = new ThrottlerStorageService();
  const increment = jest.spyOn(storage, 'increment');
  let n = 0;

  const callAt = (base: () => string, method: string, path: string, user: string | undefined, accountId?: string) =>
    fetch(`${base()}${path}`, {
      method,
      headers: {
        ...(user ? { 'x-test-user': user } : {}),
        ...(accountId ? { 'x-test-account-row': accountId } : {}),
        // Whatever else the request carries, the user comes from the session.
        'x-user-id': 'other',
        'x-forwarded-for': `198.51.100.${(++n % 250) + 1}`,
      },
    });
  const call = (method: string, path: string, user: string | undefined, accountId?: string) =>
    callAt(() => url, method, path, user, accountId);
  const callOff = (method: string, path: string, user: string | undefined) => callAt(() => offUrl, method, path, user);

  async function boot(mode: PrivacyDeletes) {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleModule],
      controllers: [MeDataController],
      providers: [
        { provide: DataExportService, useValue: { export: exportFn } },
        { provide: DataDeletionService, useValue: { deleteHistory, deleteAccount } },
        { provide: PRIVACY_DELETES, useValue: mode },
      ],
    })
      .overrideGuard(ClerkAuthGuard)
      .useValue({
        canActivate(ctx: ExecutionContext) {
          const req = ctx.switchToHttp().getRequest();
          const user = req.headers['x-test-user'];
          if (!user) throw new UnauthorizedException();
          req.user = { id: req.headers['x-test-account-row'] ?? String(user), clerkId: `user_${String(user).replace(/\W/g, '')}` };
          return true;
        },
      })
      .overrideProvider(getOptionsToken())
      .useValue({ throttlers: [] })
      .overrideProvider(getStorageToken())
      .useValue(new FailOpenStorage(storage))
      .compile();
    const a = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    (a as NestExpressApplication).set('trust proxy', 1);
    await a.listen(0, '127.0.0.1');
    return { a, u: await a.getUrl() };
  }
  beforeAll(async () => {
    ({ a: app, u: url } = await boot('history'));
    ({ a: offApp, u: offUrl } = await boot('off'));
  });
  afterAll(async () => {
    await app.close();
    await offApp.close();
  });
  beforeEach(() => {
    exportFn.mockReset();
    deleteHistory.mockReset();
    deleteAccount.mockReset();
  });

  it('GET /me/export returns the export as a dated JSON attachment, for the signed-in user only', async () => {
    exportFn.mockResolvedValue({ version: 1, journal: [] });
    const res = await call('GET', '/me/export?userId=other', 'exp-1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="larper-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(await res.json()).toEqual({ version: 1, journal: [] });
    expect(exportFn).toHaveBeenCalledTimes(1);
    expect(exportFn.mock.calls[0][0]).toBe('exp-1');
  });

  it('DELETE /me/history answers 200 with what went', async () => {
    const body = { deleted: { quests: 2, checkInAttempts: 1, hoursAnswers: 1, savedPlaces: 3, events: 4 } };
    deleteHistory.mockResolvedValue(body);
    const res = await call('DELETE', '/me/history', 'del-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
    expect(deleteHistory).toHaveBeenCalledWith(expect.objectContaining({ id: 'del-1' }));
  });

  const UNAVAILABLE = { statusCode: 503, code: 'deletes_unavailable', message: "deleting isn't available yet" };

  it('DELETE /me answers 503 even with PRIVACY_DELETES=history, and never reaches the service (0005 D7)', async () => {
    const res = await call('DELETE', '/me', 'del-2');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(await res.json()).toEqual(UNAVAILABLE);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('answers 503 deletes_unavailable on both delete routes when PRIVACY_DELETES is off, with no service call and no Retry-After', async () => {
    for (const path of ['/me/history', '/me']) {
      const res = await callOff('DELETE', path, 'del-3');
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBeNull();
      expect(await res.json()).toEqual(UNAVAILABLE);
    }
    expect(deleteHistory).not.toHaveBeenCalled();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('GET /me/export is unaffected by PRIVACY_DELETES', async () => {
    exportFn.mockResolvedValue({ version: 1 });
    expect((await callOff('GET', '/me/export', 'exp-off')).status).toBe(200);
  });

  it('the demo refusal (403) wins over the 503, on both routes and both settings, before any service call', async () => {
    const before = process.env.DEMO_CLERK_USER_ID;
    process.env.DEMO_CLERK_USER_ID = 'user_demo2';
    try {
      for (const callFn of [call, (m: string, p: string, u: string | undefined) => callOff(m, p, u)]) {
        for (const path of ['/me/history', '/me']) {
          const res = await callFn('DELETE', path, 'demo-2'); // clerkId user_demo2
          expect(res.status).toBe(403);
          expect(await res.json()).toMatchObject({ statusCode: 403, code: 'demo_account' });
        }
      }
      expect(deleteHistory).not.toHaveBeenCalled();
      expect(deleteAccount).not.toHaveBeenCalled();
    } finally {
      if (before === undefined) delete process.env.DEMO_CLERK_USER_ID;
      else process.env.DEMO_CLERK_USER_ID = before;
    }
  });

  it('answers 403 with code demo_account when the service refuses the demo account', async () => {
    deleteHistory.mockRejectedValue(new ForbiddenException(DEMO_REFUSAL));
    const res = await call('DELETE', '/me/history', 'demo-1');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ statusCode: 403, code: 'demo_account' });
  });

  it('refuses to export the shared demo account (other visitors\' data) before reaching the service', async () => {
    const before = process.env.DEMO_CLERK_USER_ID;
    process.env.DEMO_CLERK_USER_ID = 'user_demo1';
    try {
      exportFn.mockResolvedValue({ version: 1, journal: [] });
      const res = await call('GET', '/me/export', 'demo-1'); // clerkId user_demo1
      expect(res.status).toBe(403);
      expect(res.headers.get('content-disposition')).toBeNull();
      expect(await res.json()).toMatchObject({ statusCode: 403, code: 'demo_account' });
      expect(exportFn).not.toHaveBeenCalled();
      expect((await call('GET', '/me/export', 'exp-2')).status).toBe(200); // anyone else still can
    } finally {
      if (before === undefined) delete process.env.DEMO_CLERK_USER_ID;
      else process.env.DEMO_CLERK_USER_ID = before;
    }
  });

  it('answers 401 without a signed-in user, and never reaches a service', async () => {
    for (const [method, path] of [['GET', '/me/export'], ['DELETE', '/me/history'], ['DELETE', '/me']]) {
      expect((await call(method, path, undefined)).status).toBe(401);
    }
    expect(exportFn).not.toHaveBeenCalled();
    expect(deleteHistory).not.toHaveBeenCalled();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it.each(['minute', 'hour'] as const)('enforces the %s limit per subject and route across recreated rows', async (window) => {
    exportFn.mockResolvedValue({});
    deleteAccount.mockResolvedValue({});
    deleteHistory.mockResolvedValue({});
    const subject = `replace-row-${window}`;
    const name = USER_WINDOWS[window];
    const start = Date.now();
    // Space hourly test requests so the minute window expires between hits.
    const step = window === 'hour' ? MINUTE + 1 : 0;
    const clock = jest.spyOn(Date, 'now');
    try {
      for (const [method, path, handler, limits] of [
        ['GET', '/me/export', 'export', LIMITS.dataExport],
        ['DELETE', '/me/history', 'deleteHistory', LIMITS.dataDelete],
        ['DELETE', '/me', 'deleteAccount', LIMITS.dataDelete],
      ] as const) {
        increment.mockClear();
        const limit = limits[window];
        for (let i = 0; i < limit; i++) {
          clock.mockReturnValue(start + i * step);
          expect((await call(method, path, subject, String(101 + i))).status).toBe(path === '/me' ? 503 : 200);
        }
        clock.mockReturnValue(start + limit * step);
        const over = await call(method, path, subject, '999');
        expect(over.status).toBe(429);
        expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);

        const keys = increment.mock.calls.filter((args) => args[4] === name).map(([key]) => key);
        expect(keys).toHaveLength(limit + 1);
        expect(new Set(keys).size).toBe(1);
        expect(keys[0]).toMatch(new RegExp(`^rl:${name}:MeDataController\\.${handler}:[0-9a-f]{64}$`));
        expect((await call(method, path, `${subject}-other`, '999')).status).toBe(path === '/me' ? 503 : 200);
      }
    } finally {
      clock.mockRestore();
    }
  });

  it('declares the Clerk and per-user limit guards on the controller', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MeDataController)).toEqual([ClerkAuthGuard, UserLimitGuard]);
  });
});
