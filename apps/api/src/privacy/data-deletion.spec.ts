import { ForbiddenException, InternalServerErrorException, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { ClerkApiError } from '../demo/clerk-api';
import {
  InvalidClerkUserIdError,
  clerkUserDeleter,
  clerkUserDeleterFromEnv,
  type ClerkUserDeleter,
} from './clerk-user-deleter';
import { DataDeletionService } from './data-deletion';
import type { PendingClerkDeletions } from './pending-clerk-deletions';

// The Clerk half of DELETE /me, with mocks only: no request ever leaves this file.
const COUNTS = { quests: 0, checkInAttempts: 0, hoursAnswers: 0, savedPlaces: 0, events: 0, tasteProfile: true, account: true };
const USER = { id: '7', clerkId: 'user_abc123' };

// The lookup deleteAccount runs after Clerk confirms, for a row recreated in the window.
const RECREATED_LOOKUP = /^SELECT id::text AS id FROM users WHERE clerk_id/;
const deletes = (query: jest.Mock) => query.mock.calls.filter((c) => !RECREATED_LOOKUP.test(c[0]));

function service(deleter: ClerkUserDeleter | null, opts: { fail?: boolean; recreated?: string[]; recordFails?: boolean } = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = jest.fn<Promise<{ rows: any[] }>, [string, unknown[]?]>(async (sql: string) => {
    if (opts.fail) throw new Error('db down');
    if (RECREATED_LOOKUP.test(sql)) return { rows: (opts.recreated ?? []).map((id) => ({ id })) };
    return { rows: [{ r: COUNTS }] };
  });
  const forgetUser = jest.fn(async () => undefined);
  const record = jest.fn<Promise<void>, [string]>(async () => {
    if (opts.recordFails) throw new Error('db down for user_abc123');
  });
  const done = jest.fn<Promise<void>, [string]>(async () => undefined);
  const pending = { record, done } as unknown as PendingClerkDeletions;
  const svc = new DataDeletionService({ query } as unknown as Pool, { forgetUser } as unknown as CacheService, deleter, pending);
  return { svc, query, forgetUser, record, done };
}

describe('the Clerk deleter', () => {
  it('is built only for PRIVACY_DELETES=all (and needs no secret key otherwise)', () => {
    expect(clerkUserDeleterFromEnv({})).toBeNull();
    expect(clerkUserDeleterFromEnv({ PRIVACY_DELETES: 'history' })).toBeNull();
    expect(clerkUserDeleterFromEnv({ CLERK_SECRET_KEY: 'sk_test_x' })).toBeNull();
  });

  it('fails at startup for all without CLERK_SECRET_KEY', () => {
    expect(() => clerkUserDeleterFromEnv({ PRIVACY_DELETES: 'all' })).toThrow(/CLERK_SECRET_KEY/);
    expect(() => clerkUserDeleterFromEnv({ PRIVACY_DELETES: 'all', CLERK_SECRET_KEY: ' ' })).toThrow(/CLERK_SECRET_KEY/);
  });

  it('sends DELETE /v1/users/<id> with the secret key as a bearer token, to the mock fetch only', async () => {
    const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>(async () => new Response('{}', { status: 200 }));
    const del = clerkUserDeleterFromEnv(
      { PRIVACY_DELETES: 'all', CLERK_SECRET_KEY: 'sk_test_mock' },
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
    await expect(clerkUserDeleter(clerk as never)('../sessions')).rejects.toBeInstanceOf(InvalidClerkUserIdError);
    await expect(clerkUserDeleter(clerk as never)('../sessions')).rejects.toThrow(/not a Clerk user id/);
    expect(clerk).not.toHaveBeenCalled();
  });
});

describe('DataDeletionService', () => {
  const noDemo = () => {
    delete process.env.DEMO_CLERK_USER_ID;
  };
  beforeEach(noDemo);
  afterEach(() => jest.restoreAllMocks());
  afterAll(noDemo);

  it('with no deleter configured, purges nothing and calls nothing', async () => {
    const { svc, query, forgetUser } = service(null);
    await expect(svc.deleteAccount(USER)).rejects.toThrow('not configured');
    expect(query).not.toHaveBeenCalled();
    expect(forgetUser).not.toHaveBeenCalled();
  });

  it('deletes the data first, then the Clerk user', async () => {
    const order: string[] = [];
    const deleter = jest.fn(async (id: string) => void order.push(`clerk ${id}`));
    const { svc, query } = service(deleter);
    query.mockImplementation(async (sql: string) => {
      order.push(RECREATED_LOOKUP.test(sql) ? 'lookup' : 'db');
      return RECREATED_LOOKUP.test(sql) ? { rows: [] } : { rows: [{ r: COUNTS }] };
    });
    await expect(svc.deleteAccount(USER)).resolves.toEqual({ deleted: COUNTS, clerkUser: 'deleted' });
    expect(order).toEqual(['db', 'clerk user_abc123', 'lookup']);
  });

  it('after Clerk confirms, purges a row a request recreated in between, so nothing names the user', async () => {
    const logs = [
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
    ];
    const deleter = jest.fn(async () => undefined);
    const { svc, query, forgetUser } = service(deleter, { recreated: ['9'] });
    await expect(svc.deleteAccount(USER)).resolves.toEqual({ deleted: COUNTS, clerkUser: 'deleted' });
    const lookup = query.mock.calls.find((c) => RECREATED_LOOKUP.test(c[0]));
    expect(lookup?.[1]).toEqual([USER.clerkId]);
    expect(deletes(query).map((c) => c[1])).toEqual([['7'], ['9']]);
    expect(forgetUser.mock.calls).toEqual([['7'], ['9']]);
    expect(JSON.stringify(logs.flatMap((l) => l.mock.calls))).not.toMatch(/user_abc123|\b9\b/);
  });

  it('a failed recreated-row purge still reports the account deleted, and logs no id', async () => {
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { svc, query } = service(jest.fn(async () => undefined));
    query.mockImplementation(async (sql: string) => {
      if (RECREATED_LOOKUP.test(sql)) throw new Error('lookup failed for user_abc123');
      return { rows: [{ r: COUNTS }] };
    });
    await expect(svc.deleteAccount(USER)).resolves.toEqual({ deleted: COUNTS, clerkUser: 'deleted' });
    expect(log.mock.calls).toEqual([['purge of a row recreated during account deletion failed (Error)']]);
  });

  it('skips the recreated-row purge when Clerk failed (the user repeats DELETE /me instead)', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { svc, query } = service(jest.fn(async () => {
      throw new ClerkApiError(503, 'x');
    }));
    await svc.deleteAccount(USER);
    expect(query.mock.calls.some((c) => RECREATED_LOOKUP.test(c[0]))).toBe(false);
  });

  it.each([
    [new ClerkApiError(503, 'DELETE /users/user_abc123'), 'Clerk user deletion failed (HTTP 503); recorded for retry'],
    [new Error('failed for user_abc123\nresponse body'), 'Clerk user deletion failed; recorded for retry'],
  ])('reports Clerk failure with a single sanitized log message', async (error, message) => {
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const deleter = jest.fn(async () => {
      throw error;
    });
    const { svc } = service(deleter);
    await expect(svc.deleteAccount(USER)).resolves.toEqual({ deleted: COUNTS, clerkUser: 'failed' });
    expect(deleter).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([[message]]);
  });

  it('a Clerk failure records the deletion as owed (retried in the background, and ensure() refuses the id)', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { svc, record, done } = service(jest.fn(async () => {
      throw new ClerkApiError(503, 'x');
    }));
    await expect(svc.deleteAccount(USER)).resolves.toEqual({ deleted: COUNTS, clerkUser: 'failed' });
    expect(record.mock.calls).toEqual([[USER.clerkId]]);
    expect(done).not.toHaveBeenCalled();
  });

  it('if recording the owed deletion fails too, it still reports failed and logs no id', async () => {
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { svc } = service(jest.fn(async () => {
      throw new ClerkApiError(503, 'x');
    }), { recordFails: true });
    await expect(svc.deleteAccount(USER)).resolves.toEqual({ deleted: COUNTS, clerkUser: 'failed' });
    expect(log.mock.calls).toEqual([
      ['Clerk user deletion failed (HTTP 503); recorded for retry'],
      ['recording a failed Clerk deletion failed (Error)'],
    ]);
  });

  it('a Clerk success clears any owed deletion left by an earlier attempt', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { svc, done, record } = service(jest.fn(async () => undefined));
    await svc.deleteAccount(USER);
    expect(done.mock.calls).toEqual([[USER.clerkId]]);
    expect(record).not.toHaveBeenCalled();
  });

  it('a repeated DELETE /me after a Clerk failure (a request already past ensure()) purges again and retries Clerk', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const deleter = jest
      .fn<Promise<void>, [string]>()
      .mockRejectedValueOnce(new ClerkApiError(503, 'DELETE /users/user_abc123'))
      .mockResolvedValueOnce(undefined);
    const { svc, query, forgetUser } = service(deleter);
    await expect(svc.deleteAccount(USER)).resolves.toEqual({ deleted: COUNTS, clerkUser: 'failed' });
    // The still-valid session makes ensure() create an empty row; the repeat purges it.
    const EMPTY = { quests: 0, checkInAttempts: 0, hoursAnswers: 0, savedPlaces: 0, events: 0, tasteProfile: false, account: true };
    query.mockResolvedValueOnce({ rows: [{ r: EMPTY }] });
    await expect(svc.deleteAccount({ id: '8', clerkId: USER.clerkId })).resolves.toEqual({ deleted: EMPTY, clerkUser: 'deleted' });
    expect(deletes(query).map((c) => c[1])).toEqual([['7'], ['8']]);
    expect(deleter.mock.calls).toEqual([[USER.clerkId], [USER.clerkId]]);
    expect(forgetUser).toHaveBeenCalledTimes(2);
  });

  it('logs nothing that names the user, on success or failure', async () => {
    const logs = [
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    ];
    await service(async () => undefined).svc.deleteAccount(USER);
    await service(async () => {
      throw new Error('boom user_abc123 7');
    }).svc.deleteAccount(USER);
    const text = JSON.stringify(logs.flatMap((l) => l.mock.calls));
    expect(text).not.toContain('user_abc123');
    expect(text).not.toMatch(/\b7\b/);
  });

  it('an id Clerk can never delete is a 500, not "failed, retry", and the log names no id', async () => {
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { svc } = service(clerkUserDeleter(jest.fn() as never));
    const bad = { id: '7', clerkId: 'not-a-clerk-id/../x' };
    await expect(svc.deleteAccount(bad)).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(JSON.stringify(log.mock.calls)).not.toContain('not-a-clerk-id');
    expect(log.mock.calls).toHaveLength(1);
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
