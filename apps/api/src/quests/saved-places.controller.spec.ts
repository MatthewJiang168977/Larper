import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorageService, getOptionsToken, getStorageToken } from '@nestjs/throttler';
import { ClerkAuthGuard } from '../auth/auth.guard';
import { FailOpenStorage } from '../throttle/fail-open.storage';
import { UserLimitGuard } from '../throttle/guards';
import { ThrottleModule } from '../throttle/throttle.module';
import { SavedPlacesController } from './saved-places.controller';
import { QuestsService } from './quests.service';

// GET /saved-places through the real controller and its real guards (the service is a
// stub, Clerk is replaced by X-Test-User: same approach as test-app.ts, which only wires
// the QuestsController, so the app is built here).
describe('SavedPlacesController: GET /saved-places', () => {
  let app: INestApplication;
  let url: string;
  const savedPlaces = jest.fn<Promise<unknown[]>, [string]>();
  let n = 0;

  const get = (user: string | undefined, headers: Record<string, string> = {}) =>
    fetch(`${url}/saved-places`, {
      headers: {
        ...(user ? { 'x-test-user': user } : {}),
        'x-forwarded-for': `198.51.100.${(++n % 250) + 1}`,
        ...headers,
      },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleModule],
      controllers: [SavedPlacesController],
      providers: [{ provide: QuestsService, useValue: { savedPlaces } }],
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
      })
      .overrideProvider(getOptionsToken())
      .useValue({ throttlers: [] })
      .overrideProvider(getStorageToken())
      .useValue(new FailOpenStorage(new ThrottlerStorageService()))
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: ['error'] });
    (app as NestExpressApplication).set('trust proxy', 1);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(() => app.close());
  beforeEach(() => savedPlaces.mockReset());

  it("returns the service's rows for the signed-in user, and asks for that user's id only", async () => {
    const rows = [
      { id: '5', name: 'Beta Books', category: 'bookstore', savedAt: '2026-11-15T10:00:00.000Z' },
      { id: '3', name: 'Alpha Cafe', category: 'cafe', savedAt: '2026-11-14T10:00:00.000Z' },
    ];
    savedPlaces.mockResolvedValue(rows);
    // Whatever else the request carries, the id comes from the authenticated user.
    const res = await fetch(`${url}/saved-places?userId=other&user_id=other`, {
      headers: { 'x-test-user': 'ctl-sp-1', 'x-user-id': 'other', 'x-forwarded-for': '198.51.100.7' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(rows);
    expect(savedPlaces).toHaveBeenCalledTimes(1);
    expect(savedPlaces).toHaveBeenCalledWith('ctl-sp-1');
  });

  it('returns [] when nothing is saved', async () => {
    savedPlaces.mockResolvedValue([]);
    const res = await get('ctl-sp-2');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('answers 401 without a signed-in user, and never reaches the service', async () => {
    const res = await get(undefined);
    expect(res.status).toBe(401);
    expect(savedPlaces).not.toHaveBeenCalled();
  });

  it('declares the Clerk and per-user limit guards on the controller', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, SavedPlacesController)).toEqual([ClerkAuthGuard, UserLimitGuard]);
  });
});
