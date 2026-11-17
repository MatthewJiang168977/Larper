import { ForbiddenException } from '@nestjs/common';
import type { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { ClerkApiError } from '../demo/clerk-api';
import {
  clerkDeleteEnabled,
  clerkUserDeleter,
  clerkUserDeleterFromEnv,
  type ClerkUserDeleter,
} from './clerk-user-deleter';
import { DataDeletionService } from './data-deletion';

// The Clerk half of DELETE /me, with mocks only: no request ever leaves this file.
const COUNTS = { quests: 0, checkInAttempts: 0, hoursAnswers: 0, savedPlaces: 0, events: 0, tasteProfile: true, account: true };
const USER = { id: '7', clerkId: 'user_abc123' };

function service(deleter: ClerkUserDeleter | null, opts: { fail?: boolean } = {}) {
  const query = jest.fn<Promise<{ rows: { r: typeof COUNTS }[] }>, [string, unknown[]?]>(async () => {
    if (opts.fail) throw new Error('db down');
    return { rows: [{ r: COUNTS }] };
  });
  const forgetUser = jest.fn(async () => undefined);
  const svc = new DataDeletionService({ query } as unknown as Pool, { forgetUser } as unknown as CacheService, deleter);
  return { svc, query, forgetUser };
}

describe('CLERK_DELETE_USERS', () => {
  it('is off unless 1 or true', () => {
    for (const v of [undefined, '', '0', 'false', 'yes', 'off']) expect(clerkDeleteEnabled({ CLERK_DELETE_USERS: v })).toBe(false);
    for (const v of ['1', 'true', 'TRUE', ' true ']) expect(clerkDeleteEnabled({ CLERK_DELETE_USERS: v })).toBe(true);
  });

  it('builds no deleter (and needs no secret key) when off', () => {
    expect(clerkUserDeleterFromEnv({})).toBeNull();
    expect(clerkUserDeleterFromEnv({ CLERK_SECRET_KEY: 'sk_test_x' })).toBeNull();
  });

  it('fails at startup when on without CLERK_SECRET_KEY', () => {
    expect(() => clerkUserDeleterFromEnv({ CLERK_DELETE_USERS: 'true' })).toThrow(/CLERK_SECRET_KEY/);
  });

  it('when on, sends DELETE /v1/users/<id> with the secret key as a bearer token, to the mock fetch only', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(async () => new Response('{}', { status: 200 }));
    const del = clerkUserDeleterFromEnv(
      { CLERK_DELETE_USERS: '1', CLERK_SECRET_KEY: 'sk_test_mock' },
      fetchMock as unknown as typeof fetch,
    )!;
    await del('user_abc123');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.clerk.com/v1/users/user_abc123');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_test_mock');
  });

  it('treats a user Clerk no longer has (404) as deleted, and surfaces other failures', async () => {
    const calls: string[] = [];
    const clerk = (status: number) => async (method: string, path: string): Promise<never> => {
      calls.push(`${method} ${path}`);
      throw new ClerkApiError(status, `${method} ${path}`);
    };
    await expect(clerkUserDeleter(clerk(404) as never)('user_gone')).resolves.toBeUndefined();
    await expect(clerkUserDeleter(clerk(500) as never)('user_x')).rejects.toThrow(/HTTP 500/);
    expect(calls).toEqual(['DELETE /users/user_gone', 'DELETE /users/user_x']);
  });

  it('refuses an id that is not a Clerk user id before it reaches a URL', async () => {
    const clerk = jest.fn();
    await expect(clerkUserDeleter(clerk as never)('../sessions')).rejects.toThrow(/not a Clerk user id/);
    expect(clerk).not.toHaveBeenCalled();
  });
});

describe('DataDeletionService', () => {
  const noDemo = () => {
    delete process.env.DEMO_CLERK_USER_ID;
  };
  beforeEach(noDemo);
  afterAll(noDemo);

  it('flag off: deletes the data, never calls Clerk, and says the owner removes the Clerk user', async () => {
    const { svc, query, forgetUser } = service(null);
    await expect(svc.deleteAccount(USER)).resolves.toEqual({ deleted: COUNTS, clerkUser: 'manual' });
    expect(query).toHaveBeenCalledWith('SELECT delete_my_account($1) AS r', ['7']);
    expect(forgetUser).toHaveBeenCalledWith('7');
  });

  it('flag on: deletes the data first, then the Clerk user', async () => {
    const order: string[] = [];
    const deleter = jest.fn(async (id: string) => void order.push(`clerk ${id}`));
    const { svc, query } = service(deleter);
    query.mockImplementation(async () => {
      order.push('db');
      return { rows: [{ r: COUNTS }] };
    });
    await expect(svc.deleteAccount(USER)).resolves.toEqual({ deleted: COUNTS, clerkUser: 'deleted' });
    expect(order).toEqual(['db', 'clerk user_abc123']);
  });

  it('flag on, Clerk fails: the data is still gone and the answer says so', async () => {
    const deleter = jest.fn(async () => {
      throw new ClerkApiError(503, 'DELETE /users/user_abc123');
    });
    const { svc } = service(deleter);
    await expect(svc.deleteAccount(USER)).resolves.toEqual({ deleted: COUNTS, clerkUser: 'failed' });
    expect(deleter).toHaveBeenCalledTimes(1);
  });

  it('a database failure stops before Clerk: the user can still sign in to repeat it', async () => {
    const deleter = jest.fn(async () => undefined);
    const { svc } = service(deleter, { fail: true });
    await expect(svc.deleteAccount(USER)).rejects.toThrow('db down');
    expect(deleter).not.toHaveBeenCalled();
  });

  it('delete history never touches Clerk', async () => {
    const deleter = jest.fn(async () => undefined);
    const { svc, query } = service(deleter);
    await svc.deleteHistory(USER);
    expect(query).toHaveBeenCalledWith('SELECT delete_my_history($1) AS r', ['7']);
    expect(deleter).not.toHaveBeenCalled();
  });

  it('refuses the demo account for both, before any query or Clerk call', async () => {
    process.env.DEMO_CLERK_USER_ID = 'user_abc123';
    const deleter = jest.fn(async () => undefined);
    const { svc, query, forgetUser } = service(deleter);
    await expect(svc.deleteAccount(USER)).rejects.toThrow(ForbiddenException);
    await expect(svc.deleteHistory(USER)).rejects.toThrow(ForbiddenException);
    expect(query).not.toHaveBeenCalled();
    expect(forgetUser).not.toHaveBeenCalled();
    expect(deleter).not.toHaveBeenCalled();
  });
});
