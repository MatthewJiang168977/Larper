import { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { UsersService } from '../auth/users.service';
import { createPool } from '../db/db.module';
import { assertDisposableDatabase } from '../db/test-guard';
import { DataDeletionService } from './data-deletion';
import { PendingClerkDeletions } from './pending-clerk-deletions';

// Owed Clerk deletions (migration 0021) against a real database, as the API's role
// (TEST_DATABASE_URL); cleanup as the owner. Clerk is always a mock. Skipped without it.
const URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? URL;
const describeDb = URL ? describe : describe.skip;

const CLERK = 'user_pendingdbspec1';

describeDb('owed Clerk deletions (real database)', () => {
  let pool: Pool;
  let owner: Pool;
  const cache = { forgetUser: async () => undefined } as unknown as CacheService;

  beforeAll(async () => {
    pool = createPool(URL);
    owner = createPool(OWNER_URL);
    await assertDisposableDatabase(owner, 'pending-clerk-deletions.db.spec');
  });

  afterAll(async () => {
    await owner.query('DELETE FROM clerk_deletions_pending WHERE clerk_id = $1', [CLERK]);
    await owner.query('DELETE FROM users WHERE clerk_id = $1', [CLERK]);
    await pool.end();
    await owner.end();
  });

  const owed = async () =>
    (await owner.query<{ attempts: number; due: boolean }>(
      `SELECT attempts, next_attempt_at <= now() AS due FROM clerk_deletions_pending WHERE clerk_id = $1`,
      [CLERK],
    )).rows;

  it('a failed Clerk call records the deletion; ensure() then refuses the id; a later success clears it', async () => {
    const users = new UsersService(pool, async () => true);
    const id = await users.ensure(CLERK);

    let clerkUp = false;
    const clerk = async () => {
      if (!clerkUp) throw new Error('clerk down');
    };
    const pending = new PendingClerkDeletions(pool, cache, clerk);
    const deletion = new DataDeletionService(pool, cache, clerk, pending);

    await expect(deletion.deleteAccount({ id, clerkId: CLERK })).resolves.toMatchObject({ clerkUser: 'failed' });
    expect(await owed()).toEqual([{ attempts: 1, due: true }]);

    // The still-valid session comes back: no new account for an owed id.
    await expect(users.ensure(CLERK)).rejects.toMatchObject({ response: { code: 'account_gone' } });
    expect((await owner.query('SELECT 1 FROM users WHERE clerk_id = $1', [CLERK])).rows).toHaveLength(0);

    // A retry while Clerk is still down backs off.
    await pending.retryDue();
    expect(await owed()).toEqual([{ attempts: 2, due: false }]);

    // Clerk is back and the row is due again: the retry settles it.
    await owner.query('UPDATE clerk_deletions_pending SET next_attempt_at = now() WHERE clerk_id = $1', [CLERK]);
    clerkUp = true;
    await expect(pending.retryDue()).resolves.toBe(1);
    expect(await owed()).toEqual([]);
  });

  it('the API role cannot delete a record directly, only through clerk_deletion_done()', async () => {
    await pool.query('INSERT INTO clerk_deletions_pending (clerk_id) VALUES ($1) ON CONFLICT DO NOTHING', [CLERK]);
    await expect(pool.query('DELETE FROM clerk_deletions_pending WHERE clerk_id = $1', [CLERK])).rejects.toThrow(/permission denied/);
    await expect(pool.query('SELECT clerk_deletion_done($1) AS gone', [CLERK])).resolves.toMatchObject({ rows: [{ gone: true }] });
    await expect(pool.query('SELECT clerk_deletion_done($1) AS gone', [CLERK])).resolves.toMatchObject({ rows: [{ gone: false }] });
  });

  it('refuses anything that is not a Clerk user id', async () => {
    await expect(pool.query('INSERT INTO clerk_deletions_pending (clerk_id) VALUES ($1)', ['not/a/clerk/id'])).rejects.toThrow(/check constraint/);
  });
});
