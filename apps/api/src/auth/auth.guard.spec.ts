import { Controller, ExecutionContext, Get, INestApplication, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PG } from '../db/db.module';
import { ClerkAuthGuard } from './auth.guard';
import { CLERK_USER_CHECK } from './clerk-user-check';
import { frontendApiFromPublishableKey } from './publishable-key';
import { SESSION_VERIFIER } from './session-verifier';
import { ACCOUNT_GONE, UsersService } from './users.service';

const ctxFor = (headers: Record<string, string>) => {
  const req: { headers: Record<string, string>; user?: unknown } = { headers };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { ctx, req };
};

describe('ClerkAuthGuard', () => {
  const users = { ensure: jest.fn(async () => '42') } as unknown as UsersService;
  const verify = jest.fn(async (token: string) => {
    if (token !== 'good') throw new Error('bad signature');
    return { clerkId: 'user_abc' };
  });
  const guard = new ClerkAuthGuard(verify, users);

  it('attaches our user id for a valid token', async () => {
    const { ctx, req } = ctxFor({ authorization: 'Bearer good' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toEqual({ clerkId: 'user_abc', id: '42' });
  });

  it('rejects a missing header', async () => {
    await expect(guard.canActivate(ctxFor({}).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token that fails verification as 401, not 500', async () => {
    const { ctx } = ctxFor({ authorization: 'Bearer forged' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// Over HTTP, through Nest's own exception handling: the web (PR #101) reads code account_gone,
// and only that, as "your account is already deleted". So that body must arrive intact, and
// the guard's own 401s (no token, a token that fails verification) must carry no code.
describe('ClerkAuthGuard over HTTP: which 401 says account_gone', () => {
  @Controller('probe')
  @UseGuards(ClerkAuthGuard)
  class ProbeController {
    @Get()
    get() {
      return { ok: true };
    }
  }

  let app: INestApplication;
  let url: string;
  beforeAll(async () => {
    // A user Clerk no longer has: no row, and the Clerk check says 404 (a mock: no request leaves).
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        ClerkAuthGuard,
        UsersService,
        { provide: PG, useValue: pg },
        { provide: CLERK_USER_CHECK, useValue: async () => false },
        {
          provide: SESSION_VERIFIER,
          useValue: async (token: string) => {
            if (token !== 'good') throw new Error('bad signature');
            return { clerkId: 'user_gone1' };
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(() => app.close());

  const probe = async (headers: Record<string, string>) => {
    const res = await fetch(`${url}/probe`, { headers });
    return { status: res.status, body: (await res.json()) as { code?: string; message?: string } };
  };

  it('a deleted user (Clerk says 404) gets 401 with code account_gone, naming no one', async () => {
    const { status, body } = await probe({ authorization: 'Bearer good' });
    expect(status).toBe(401);
    expect(body).toMatchObject({ statusCode: 401, code: ACCOUNT_GONE });
    expect(JSON.stringify(body)).not.toContain('user_gone1');
  });

  it.each([
    ['no token', {}],
    ['a token that fails verification', { authorization: 'Bearer forged' }],
  ])('%s gets a bare 401, with no code', async (_, headers) => {
    const { status, body } = await probe(headers);
    expect(status).toBe(401);
    expect(body.code).toBeUndefined();
  });
});

describe('frontendApiFromPublishableKey', () => {
  it('decodes the instance host', () => {
    const key = 'pk_test_' + Buffer.from('example-1.clerk.accounts.dev$').toString('base64');
    expect(frontendApiFromPublishableKey(key)).toBe('example-1.clerk.accounts.dev');
  });

  it('decodes a production domain from a live publishable key', () => {
    const key = 'pk_live_' + Buffer.from('clerk.example.com$').toString('base64');
    expect(frontendApiFromPublishableKey(key)).toBe('clerk.example.com');
  });

  it('rejects things that are not publishable keys', () => {
    expect(() => frontendApiFromPublishableKey('sk_test_abc')).toThrow();
  });
});
