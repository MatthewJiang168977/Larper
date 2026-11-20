import { Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Pool } from 'pg';
import { ClerkApiError } from '../demo/clerk-api';
import { clerkUserCheck, clerkUserCheckFromEnv } from './clerk-user-check';
import { ACCOUNT_GONE, GONE_TTL_MS, UsersService } from './users.service';

// UsersService.ensure with PRIVACY_DELETES=all: a new row only for a Clerk user that
// still exists. Clerk is always a mock here; the pool is a fake with a users table.
const ID = 'user_abc123';

function fakePool(existing: Record<string, string> = {}) {
  const users = { ...existing };
  let next = 100;
  const query = jest.fn(async (sql: string, params: string[]) => {
    const [key] = params;
    if (sql.startsWith('SELECT id FROM users')) return { rows: users[key] ? [{ id: users[key] }] : [] };
    if (sql.startsWith('SELECT delete_my_account')) {
      for (const [c, id] of Object.entries(users)) if (id === key) delete users[c];
      return { rows: [{}] };
    }
    const created = users[key] === undefined; // the insert
    users[key] ??= String(next++);
    return { rows: [{ id: users[key], created }] };
  });
  return { pool: { query } as unknown as Pool, users, query };
}

describe('UsersService.ensure with the Clerk check', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.DEMO_CLERK_USER_ID;
  });

  it('creates an unknown user when Clerk has them (200)', async () => {
    const { pool, users } = fakePool();
    const check = jest.fn(async () => true);
    await expect(new UsersService(pool, check).ensure(ID)).resolves.toBe('100');
    // Once before the insert, once (fresh) after it: see the race test below.
    expect(check.mock.calls).toEqual([[ID], [ID]]);
    expect(users[ID]).toBe('100');
  });

  it('a row created just as DELETE /me removed the Clerk user is purged again, and the request refused', async () => {
    // Check passes (Clerk still has the user), DELETE /me then deletes the Clerk user and
    // runs its last purge, and only then does this insert land.
    const { pool, users, query } = fakePool();
    const check = jest.fn<Promise<boolean>, [string]>().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(new UsersService(pool, check).ensure(ID)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(users).toEqual({});
    expect(query.mock.calls.some(([sql, p]) => sql.startsWith('SELECT delete_my_account') && p[0] === '100')).toBe(true);
  });

  it('keeps a new row when the recheck itself fails (a brand-new sign-up), logging no id', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { pool, users } = fakePool();
    const check = jest
      .fn<Promise<boolean>, [string]>()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new ClerkApiError(502, `GET /users/${ID}`));
    await expect(new UsersService(pool, check).ensure(ID)).resolves.toBe('100');
    expect(users[ID]).toBe('100');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(ID);
  });

  it('remembers a 404 for a few seconds, so a stale token does not call Clerk on every request', async () => {
    jest.useFakeTimers();
    try {
      const { pool } = fakePool();
      const check = jest.fn(async () => false);
      const svc = new UsersService(pool, check);
      for (let i = 0; i < 5; i++) await expect(svc.ensure(ID)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(check).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(GONE_TTL_MS + 1);
      await expect(svc.ensure(ID)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(check).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('401 and no row when Clerk says 404', async () => {
    const { pool, users } = fakePool();
    await expect(new UsersService(pool, async () => false).ensure(ID)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(users).toEqual({});
  });

  // The web reads "your account is already deleted" from this code and nothing else: a bare
  // 401 (no token, a token that fails verification) must never look like it.
  const goneBody = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnauthorizedException);
    return (err as UnauthorizedException).getResponse();
  };

  it('says account_gone, in the body, on every "Clerk has no such user" 401', async () => {
    const want = { statusCode: 401, code: ACCOUNT_GONE };
    // Before the insert.
    expect(await goneBody(new UsersService(fakePool().pool, async () => false).ensure(ID))).toMatchObject(want);
    // After the recheck purged a row this request made.
    const recheck = jest.fn<Promise<boolean>, [string]>().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await goneBody(new UsersService(fakePool().pool, recheck).ensure(ID))).toMatchObject(want);
    // From the in-memory 404 cache.
    const svc = new UsersService(fakePool().pool, async () => false);
    await svc.ensure(ID).catch(() => undefined);
    expect(await goneBody(svc.ensure(ID))).toMatchObject(want);
  });

  it('a lost insert race whose winner was purged by its recheck is account_gone, not a 500', async () => {
    // Our insert does nothing (another pod won), and by our re-read the winner's recheck has
    // already purged that row: nothing is there.
    const query = jest.fn(async (sql: string) => {
      if (sql.startsWith('SELECT id FROM users')) return { rows: [] };
      return { rows: [] }; // the insert CTE: found nothing, inserted nothing
    });
    const err = goneBody(new UsersService({ query } as unknown as Pool, async () => true).ensure(ID));
    expect(await err).toMatchObject({ statusCode: 401, code: ACCOUNT_GONE });
  });

  it('503 and no row when Clerk fails (5xx, timeout), logging no id', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    for (const err of [new ClerkApiError(502, `GET /users/${ID}`), new Error(`timeout for ${ID}`)]) {
      const { pool, users } = fakePool();
      await expect(
        new UsersService(pool, async () => {
          throw err;
        }).ensure(ID),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(users).toEqual({});
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain(ID);
  });

  it('never calls Clerk for an existing user', async () => {
    const { pool } = fakePool({ [ID]: '7' });
    const check = jest.fn(async () => true);
    await expect(new UsersService(pool, check).ensure(ID)).resolves.toBe('7');
    expect(check).not.toHaveBeenCalled();
  });

  it('never calls Clerk when the mode is off or history (no check configured)', async () => {
    const { pool } = fakePool();
    await expect(new UsersService(pool, null).ensure(ID)).resolves.toBe('100');
    expect(clerkUserCheckFromEnv({})).toBeNull();
    expect(clerkUserCheckFromEnv({ PRIVACY_DELETES: 'history', CLERK_SECRET_KEY: 'sk_test_mock' })).toBeNull();
  });

  it('never calls Clerk for the demo user', async () => {
    process.env.DEMO_CLERK_USER_ID = ID;
    const { pool } = fakePool();
    const check = jest.fn(async () => false);
    await expect(new UsersService(pool, check).ensure(ID)).resolves.toBe('100');
    expect(check).not.toHaveBeenCalled();
  });

  it('concurrent first requests share one Clerk call', async () => {
    const { pool } = fakePool();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const check = jest.fn(async () => {
      await gate;
      return true;
    });
    const svc = new UsersService(pool, check);
    const all = Promise.all([svc.ensure(ID), svc.ensure(ID), svc.ensure(ID)]);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await expect(all).resolves.toEqual(['100', '100', '100']);
    // One shared check before the insert, plus the one fresh recheck by the request that inserted.
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe('clerkUserCheck', () => {
  it('GETs /users/<id>: true on 200, false on 404, throws on anything else', async () => {
    const calls: string[] = [];
    const clerk = (status: number) => async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      if (status !== 200) throw new ClerkApiError(status, `${method} ${path}`);
      return {};
    };
    await expect(clerkUserCheck(clerk(200) as never)(ID)).resolves.toBe(true);
    await expect(clerkUserCheck(clerk(404) as never)(ID)).resolves.toBe(false);
    await expect(clerkUserCheck(clerk(500) as never)(ID)).rejects.toBeInstanceOf(ClerkApiError);
    expect(calls).toEqual([`GET /users/${ID}`, `GET /users/${ID}`, `GET /users/${ID}`]);
  });

  it('treats something that is not a Clerk user id as no such user, without a call', async () => {
    const clerk = jest.fn();
    await expect(clerkUserCheck(clerk as never)('../x')).resolves.toBe(false);
    expect(clerk).not.toHaveBeenCalled();
  });

  it('is built for PRIVACY_DELETES=all and sends the GET to the mock fetch only', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(async () => new Response('{}', { status: 200 }));
    const check = clerkUserCheckFromEnv({ PRIVACY_DELETES: 'all', CLERK_SECRET_KEY: 'sk_test_mock' }, fetchMock as unknown as typeof fetch)!;
    await expect(check(ID)).resolves.toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.clerk.com/v1/users/${ID}`);
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });
});
