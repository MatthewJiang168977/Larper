import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorageService, getOptionsToken, getStorageToken } from '@nestjs/throttler';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { FailOpenStorage } from '../throttle/fail-open.storage';
import { ThrottleModule } from '../throttle/throttle.module';
import { AdminGuard } from './admin.guard';
import { CurationController } from './curation.controller';
import { CurationService } from './curation.service';

// The admin routes through the real controller and AdminGuard (Clerk replaced by X-Test-User,
// the service a stub): who gets in, and that everyone else sees a route that doesn't exist.
describe('/admin/places', () => {
  let app: INestApplication;
  let url: string;
  const list = jest.fn(async () => ({ places: [] }));
  const record = jest.fn(async () => ({ id: '5' }));
  const saved = { ...process.env };

  const call = (path: string, user?: string, init: RequestInit = {}) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: { ...(user ? { 'x-test-user': user } : {}), 'content-type': 'application/json' },
    });
  const routes: [string, RequestInit][] = [
    ['/admin/places', {}],
    ['/admin/places/5/facts', { method: 'POST', body: JSON.stringify({ kind: 'verified' }) }],
  ];

  beforeAll(async () => {
    const clerk = {
      async canActivate(ctx: ExecutionContext) {
        const req = ctx.switchToHttp().getRequest();
        const user = req.headers['x-test-user'];
        if (!user) throw new UnauthorizedException();
        req.user = { id: String(user), clerkId: `user_test${user}` };
        return true;
      },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleModule],
      controllers: [CurationController],
      providers: [
        AdminGuard,
        { provide: ClerkAuthGuard, useValue: clerk },
        { provide: CurationService, useValue: { list, record } },
      ],
    })
      .overrideProvider(getOptionsToken())
      .useValue({ throttlers: [] })
      .overrideProvider(getStorageToken())
      .useValue(new FailOpenStorage(new ThrottlerStorageService()))
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    process.env = saved;
    await app.close();
  });
  beforeEach(() => {
    process.env = { ...saved, ADMIN_USER_IDS: '1, user_test2,3', DEMO_CLERK_USER_ID: 'user_test3' };
    list.mockClear();
    record.mockClear();
  });

  it.each(routes)('answers a signed-out, other or demo caller of %s as a missing route', async (path, init) => {
    const unknown = await call('/admin/nothing', undefined, init);
    expect(unknown.status).toBe(404);
    for (const user of [undefined, '9', '3']) {
      const res = await call(path, user, init);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ statusCode: 404, error: 'Not Found', message: `Cannot ${init.method ?? 'GET'} ${path}` });
    }
    expect(list).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('has no admins when ADMIN_USER_IDS is unset', async () => {
    delete process.env.ADMIN_USER_IDS;
    expect((await call('/admin/places', '1')).status).toBe(404);
  });

  it('lets an admin in by Larper id or Clerk id', async () => {
    expect((await call('/admin/places?area=union-square', '1')).status).toBe(200);
    expect(list).toHaveBeenLastCalledWith('union-square');
    expect((await call('/admin/places', '2')).status).toBe(200);
    expect(list).toHaveBeenLastCalledWith('east-village');
  });

  it("records with the caller's own id, and refuses a bad place id", async () => {
    const res = await call('/admin/places/5/facts', '1', { method: 'POST', body: JSON.stringify({ kind: 'verified' }) });
    expect(res.status).toBe(200);
    expect(record).toHaveBeenCalledWith('1', '5', { kind: 'verified' });
    expect((await call('/admin/places/abc/facts', '1', { method: 'POST', body: '{}' })).status).toBe(400);
  });
});
