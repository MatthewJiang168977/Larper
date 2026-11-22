import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { CacheService } from '../cache/cache.service';
import { ClerkApiError } from '../demo/clerk-api';
import { PG } from '../db/db.module';
import { CLERK_USER_DELETER, InvalidClerkUserIdError, type ClerkUserDeleter } from './clerk-user-deleter';

// Clerk users whose deletion is still owed (migration 0021; docs/decisions/0005, D8).
// DELETE /me records one when Clerk fails after Larper's data is gone; this service
// retries it in the background until Clerk confirms, and ensure() refuses to recreate an
// account for a listed id meanwhile. Logs carry counts and HTTP statuses, never an id.

/** Seconds between looks for due retries. Each look is one indexed query. */
export const RETRY_EVERY_MS = 60_000;
/** At most this many Clerk calls per look. */
const BATCH = 20;
/** Any number will do, as long as nothing else in Larper takes the same advisory lock. */
const RETRY_LOCK_KEY = 0x4c4b_4443; // "LKDC"

/**
 * Removes any users row that still names this Clerk id (made by a request that raced the
 * deletion), with its data and cached decks. Shared by DELETE /me, the retry and the
 * Clerk webhook.
 */
export async function purgeClerkId(pg: Pool, cache: CacheService | null, clerkId: string): Promise<number> {
  const { rows } = await pg.query<{ id: string }>('SELECT id::text AS id FROM users WHERE clerk_id = $1', [clerkId]);
  for (const { id } of rows) {
    await pg.query('SELECT delete_my_account($1)', [id]);
    await cache?.forgetUser(id);
  }
  return rows.length;
}

@Injectable()
export class PendingClerkDeletions implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('PendingClerkDeletions');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastStatus: number | undefined;

  constructor(
    @Inject(PG) private readonly pg: Pool,
    private readonly cache: CacheService,
    @Inject(CLERK_USER_DELETER) private readonly clerkDelete: ClerkUserDeleter | null,
  ) {}

  onModuleInit(): void {
    // Without a deleter (PRIVACY_DELETES is not 'all') nothing can be retried, and no
    // DELETE /me can have recorded anything.
    if (!this.clerkDelete) return;
    this.timer = setInterval(() => void this.retryDue(), RETRY_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Remembers that this Clerk user still has to be deleted, and when to try again. */
  async record(clerkId: string): Promise<void> {
    await this.pg.query(
      `INSERT INTO clerk_deletions_pending AS p (clerk_id) VALUES ($1)
       ON CONFLICT (clerk_id) DO UPDATE
         SET attempts = p.attempts + 1,
             next_attempt_at = now() + least(interval '1 minute' * power(2, least(p.attempts, 10)), interval '6 hours')`,
      [clerkId],
    );
  }

  async isPending(clerkId: string): Promise<boolean> {
    const { rows } = await this.pg.query('SELECT 1 FROM clerk_deletions_pending WHERE clerk_id = $1', [clerkId]);
    return rows.length > 0;
  }

  /** Clerk no longer has the user: forget it. */
  async done(clerkId: string): Promise<void> {
    await this.pg.query('SELECT clerk_deletion_done($1)', [clerkId]);
  }

  /**
   * One pass over the due rows. One replica at a time (an advisory lock on one pooled
   * connection), so two pods never call Clerk for the same user at once. Returns how
   * many were settled; never throws.
   */
  async retryDue(): Promise<number> {
    const del = this.clerkDelete;
    if (!del || this.running) return 0;
    this.running = true;
    let settled = 0;
    let failed = 0;
    const client = await this.pg.connect().catch(() => null);
    if (!client) {
      this.running = false;
      return 0;
    }
    try {
      const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [RETRY_LOCK_KEY]);
      if (!lock.rows[0]?.ok) return 0;
      try {
        const { rows } = await client.query<{ clerkId: string }>(
          `SELECT clerk_id AS "clerkId" FROM clerk_deletions_pending
           WHERE next_attempt_at <= now() ORDER BY next_attempt_at LIMIT $1`,
          [BATCH],
        );
        for (const { clerkId } of rows) {
          try {
            await del(clerkId);
          } catch (err) {
            if (err instanceof InvalidClerkUserIdError) {
              // The table's CHECK makes this unreachable; never retry it in a loop.
              this.log.error('a pending Clerk deletion has an invalid id');
            }
            failed++;
            await this.record(clerkId);
            if (err instanceof ClerkApiError) this.lastStatus = err.status;
            continue;
          }
          await purgeClerkId(this.pg, this.cache, clerkId);
          await this.done(clerkId);
          settled++;
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [RETRY_LOCK_KEY]);
      }
    } catch (err) {
      this.log.error(`pending Clerk deletions: retry pass failed (${(err as Error).constructor.name})`);
    } finally {
      client.release();
      this.running = false;
    }
    if (settled) this.log.log(`pending Clerk deletions: ${settled} settled`);
    if (failed) {
      const status = this.lastStatus === undefined ? '' : ` (last HTTP ${this.lastStatus})`;
      this.log.warn(`pending Clerk deletions: ${failed} still failing${status}`);
    }
    return settled;
  }
}
