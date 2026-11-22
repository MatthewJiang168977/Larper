import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { ClerkApiError } from '../demo/clerk-api';
import type { ClerkUserDeleter } from './clerk-user-deleter';
import { PendingClerkDeletions } from './pending-clerk-deletions';

// The background retry with a fake pool and a mock Clerk deleter: no request leaves here.
function setup(opts: { due?: string[]; locked?: boolean; users?: Record<string, string> } = {}) {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const run = jest.fn(async (q: string, p: unknown[] = []) => {
    sql.push(q);
    params.push(p);
    if (q.includes('pg_try_advisory_lock')) return { rows: [{ ok: opts.locked !== true }] };
    if (q.includes('FROM clerk_deletions_pending') && q.includes('next_attempt_at <= now()'))
      return { rows: (opts.due ?? []).map((clerkId) => ({ clerkId })) };
    if (q.startsWith('SELECT id::text AS id FROM users')) {
      const id = opts.users?.[p[0] as string];
      return { rows: id ? [{ id }] : [] };
    }
    return { rows: [] };
  });
  const release = jest.fn();
  const pool = { query: run, connect: jest.fn(async () => ({ query: run, release })) } as unknown as Pool;
  const forgetUser = jest.fn(async () => undefined);
  return { pool, sql, params, release, cache: { forgetUser } as unknown as CacheService, forgetUser };
}

describe('PendingClerkDeletions', () => {
  let logs: jest.SpyInstance[];
  beforeEach(() => {
    logs = (['log', 'warn', 'error'] as const).map((m) => jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined));
  });
  afterEach(() => jest.restoreAllMocks());
  const logText = () => JSON.stringify(logs.flatMap((l) => l.mock.calls));

  it('records an owed deletion as an upsert that backs off', async () => {
    const { pool, sql, params, cache } = setup();
    await new PendingClerkDeletions(pool, cache, null).record('user_a1');
    expect(sql[0]).toMatch(/INSERT INTO clerk_deletions_pending/);
    expect(sql[0]).toMatch(/ON CONFLICT \(clerk_id\) DO UPDATE/);
    expect(sql[0]).toMatch(/interval '6 hours'/);
    expect(params[0]).toEqual(['user_a1']);
  });

  it('removes a settled one through clerk_deletion_done(), never a DELETE', async () => {
    const { pool, sql, cache } = setup();
    await new PendingClerkDeletions(pool, cache, null).done('user_a1');
    expect(sql).toEqual(['SELECT clerk_deletion_done($1)']);
  });

  it('does nothing, and starts no timer, without a Clerk deleter (PRIVACY_DELETES is not all)', async () => {
    const { pool, sql, cache } = setup({ due: ['user_a1'] });
    const p = new PendingClerkDeletions(pool, cache, null);
    p.onModuleInit();
    await expect(p.retryDue()).resolves.toBe(0);
    expect(sql).toEqual([]);
    p.onModuleDestroy();
  });

  it('retries each due one: on success purges any recreated row and clears it; on failure backs off', async () => {
    const { pool, sql, params, cache, forgetUser, release } = setup({ due: ['user_ok', 'user_bad'], users: { user_ok: '9' } });
    const del = jest.fn<ReturnType<ClerkUserDeleter>, Parameters<ClerkUserDeleter>>(async (id) => {
      if (id === 'user_bad') throw new ClerkApiError(503, 'DELETE /users/user_bad');
    });
    await expect(new PendingClerkDeletions(pool, cache, del).retryDue()).resolves.toBe(1);
    expect(del.mock.calls).toEqual([['user_ok'], ['user_bad']]);
    expect(forgetUser.mock.calls).toEqual([['9']]);
    const at = (re: RegExp) => sql.findIndex((q) => re.test(q));
    expect(params[at(/delete_my_account/)]).toEqual(['9']);
    expect(params[at(/clerk_deletion_done/)]).toEqual(['user_ok']);
    expect(params[at(/INSERT INTO clerk_deletions_pending/)]).toEqual(['user_bad']);
    expect(sql.some((q) => q.includes('pg_advisory_unlock'))).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(logText()).toContain('1 settled');
    expect(logText()).toContain('1 still failing (last HTTP 503)');
    expect(logText()).not.toMatch(/user_ok|user_bad|\b9\b/);
  });

  it('skips the pass when another replica holds the lock', async () => {
    const { pool, sql, cache, release } = setup({ due: ['user_a1'], locked: true });
    const del = jest.fn(async () => undefined);
    await expect(new PendingClerkDeletions(pool, cache, del).retryDue()).resolves.toBe(0);
    expect(del).not.toHaveBeenCalled();
    expect(sql.some((q) => q.includes('clerk_deletions_pending'))).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('never throws, and logs no id, when the database fails mid-pass', async () => {
    const { pool, cache } = setup({ due: ['user_a1'] });
    (pool.connect as jest.Mock).mockResolvedValueOnce({
      query: jest.fn(async (q: string) => {
        if (q.includes('pg_try_advisory_lock')) return { rows: [{ ok: true }] };
        throw new Error('db down user_a1');
      }),
      release: jest.fn(),
    });
    await expect(new PendingClerkDeletions(pool, cache, jest.fn(async () => undefined)).retryDue()).resolves.toBe(0);
    expect(logText()).toContain('retry pass failed (Error)');
    expect(logText()).not.toContain('user_a1');
  });
});
