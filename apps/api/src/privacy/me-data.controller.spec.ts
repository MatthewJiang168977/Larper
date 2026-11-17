import { ExecutionContext, ForbiddenException, INestApplication, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorageService, getOptionsToken, getStorageToken } from '@nestjs/throttler';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { FailOpenStorage } from '../throttle/fail-open.storage';
import { UserLimitGuard } from '../throttle/guards';
import { LIMITS } from '../throttle/limits';
import { ThrottleModule } from '../throttle/throttle.module';
import { DEMO_REFUSAL, DataDeletionService } from './data-deletion';
import { DataExportService } from './data-export';
import { MeDataController } from './me-data.controller';

// GET /me/export, DELETE /me/history and DELETE /me through the real controller and its
// real guards (the services are stubs; Clerk is replaced by X-Test-User, as in
// saved-places.controller.spec.ts).
describe('MeDataController', () => {
  let app: INestApplication;
  let url: string;
  const exportFn = jest.fn();
  const deleteHistory = jest.fn();
  const deleteAccount = jest.fn();
  let n = 0;

  const call = (method: string, path: string, user: string | undefined) =>
    fetch(`${url}${path}`, {
      method,
      headers: {
        ...(user ? { 'x-test-user': user } : {}),
        // Whatever else the request carries, the user comes from the session.
        'x-user-id': 'other',
        'x-forwarded-for': `198.51.100.${(++n % 250) + 1}`,
      },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleModule],
      controllers: [MeDataController],
      providers: [
        { provide: DataExportService, useValue: { export: exportFn } },
        { provide: DataDeletionService, useValue: { deleteHistory, deleteAccount } },
      ],
    })
      .overrideGuard(ClerkAuthGuard)
      .useValue({
        canActivate(ctx: ExecutionContext) {
          const req = ctx.switchToHttp().getRequest();
          const user = req.headers['x-test-user'];
          if (!user) throw new UnauthorizedException();
          req.user = { id: String(user), clerkId: `user_${String(user).replace(/\W/g, '')}` };
          return true;
        },
      })
      .overrideProvider(getOptionsToken())
      .useValue({ throttlers: [] })
      .overrideProvider(getStorageToken())
      .useValue(new FailOpenStorage(new ThrottlerStorageService()))
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    (app as NestExpressApplication).set('trust proxy', 1);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(() => app.close());
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

  it('DELETE /me answers 200 with what went and the Clerk outcome', async () => {
    const body = { deleted: { account: true }, clerkUser: 'manual' };
    deleteAccount.mockResolvedValue(body);
    const res = await call('DELETE', '/me', 'del-2');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
    expect(deleteAccount).toHaveBeenCalledWith(expect.objectContaining({ id: 'del-2' }));
  });

  it('answers 403 with code demo_account when the service refuses the demo account', async () => {
    deleteHistory.mockRejectedValue(new ForbiddenException(DEMO_REFUSAL));
    deleteAccount.mockRejectedValue(new ForbiddenException(DEMO_REFUSAL));
    for (const path of ['/me/history', '/me']) {
      const res = await call('DELETE', path, 'demo-1');
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ statusCode: 403, code: 'demo_account' });
    }
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

  it('limits each route per user per minute, with Retry-After, and counts users separately', async () => {
    exportFn.mockResolvedValue({});
    deleteAccount.mockResolvedValue({});
    deleteHistory.mockResolvedValue({});
    for (const [method, path, limit] of [
      ['GET', '/me/export', LIMITS.dataExport.minute],
      ['DELETE', '/me/history', LIMITS.dataDelete.minute],
      ['DELETE', '/me', LIMITS.dataDelete.minute],
    ] as const) {
      const user = `lim-${method}${path.replace(/\W/g, '')}`;
      for (let i = 0; i < limit; i++) expect((await call(method, path, user)).status).toBe(200);
      const over = await call(method, path, user);
      expect(over.status).toBe(429);
      expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await call(method, path, `${user}-other`)).status).toBe(200);
    }
  });

  it('declares the Clerk and per-user limit guards on the controller', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MeDataController)).toEqual([ClerkAuthGuard, UserLimitGuard]);
  });
});
