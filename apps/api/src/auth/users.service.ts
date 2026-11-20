import { Inject, Injectable, Logger, Optional, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG } from '../db/db.module';
import { isDemoUser } from '../demo/demo-account';
import { CacheService } from '../cache/cache.service';
import { CLERK_USER_CHECK, type ClerkUserCheck } from './clerk-user-check';

@Injectable()
export class UsersService {
  private readonly log = new Logger(UsersService.name);
  // First requests of the same brand-new user share one Clerk call.
  private readonly checking = new Map<string, Promise<boolean>>();
  // Clerk ids Clerk just said it doesn't have, until when (ms). See rememberGone.
  private readonly gone = new Map<string, number>();

  constructor(
    @Inject(PG) private readonly pg: Pool,
    // Null unless PRIVACY_DELETES=all (clerk-user-check.ts).
    @Optional() @Inject(CLERK_USER_CHECK) private readonly clerkCheck: ClerkUserCheck | null = null,
    // The app's one cache (CacheModule, global). Optional for tests that build this directly.
    @Optional() private readonly cache: CacheService | null = null,
  ) {}

  // Returns our user id for a Clerk user, creating the row on first sight.
  // Read-first so the common case is a plain index lookup, not a write.
  // With the Clerk check on, a row is created only if Clerk still has the user: 401 if it
  // does not (a token that outlived DELETE /me), 503 if Clerk can't say. No row either way.
  async ensure(clerkId: string): Promise<string> {
    const existing = await this.pg.query<{ id: string }>('SELECT id FROM users WHERE clerk_id = $1', [clerkId]);
    if (existing.rows.length) return existing.rows[0].id;

    // The demo user always has a row (and is never deleted); it never triggers the call.
    if (this.clerkCheck && !isDemoUser(clerkId)) {
      let exists: boolean;
      try {
        exists = await this.checkOnce(this.clerkCheck, clerkId);
      } catch (err) {
        // The error's text can name the Clerk id (it carries the request path): log the status only.
        const status = (err as { status?: unknown }).status;
        this.log.warn(`Clerk user check failed${typeof status === 'number' ? ` (HTTP ${status})` : ''}`);
        throw new ServiceUnavailableException();
      }
      if (!exists) throw accountGone();
    }

    const { rows } = await this.pg.query<{ id: string; created: boolean }>(
      `WITH found AS (SELECT id FROM users WHERE clerk_id = $1),
            ins AS (
              INSERT INTO users (clerk_id) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM found)
              ON CONFLICT (clerk_id) DO NOTHING
              RETURNING id)
       SELECT id, false AS created FROM found UNION ALL SELECT id, true AS created FROM ins`,
      [clerkId],
    );
    // Two replicas racing on a brand-new user: the loser's insert does nothing.
    if (!rows.length) {
      const again = await this.pg.query<{ id: string }>('SELECT id FROM users WHERE clerk_id = $1', [clerkId]);
      // The winner's recheck can have purged it (Clerk no longer has the user).
      if (!again.rows.length) throw accountGone();
      return again.rows[0].id;
    }
    const { id, created } = rows[0];
    if (created && this.clerkCheck && !isDemoUser(clerkId)) await this.confirmCreated(this.clerkCheck, clerkId, id);
    return id;
  }

  // The check above can pass just before DELETE /me removes the Clerk user, and the insert
  // land just after that request's last purge: the new row would then name a deleted user
  // for good. So a row this request created is checked again with a fresh call (not one
  // shared with requests that started earlier): if Clerk has no such user now, the row goes
  // and the request is refused. If Clerk can't say, the row stays (the user most likely
  // exists; this is a brand-new sign-up) and the log names no one.
  private async confirmCreated(check: ClerkUserCheck, clerkId: string, id: string): Promise<void> {
    let exists: boolean;
    try {
      exists = await check(clerkId);
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      this.log.warn(`Clerk recheck of a new account failed${typeof status === 'number' ? ` (HTTP ${status})` : ''}`);
      return;
    }
    if (exists) return;
    this.rememberGone(clerkId);
    await this.pg.query('SELECT delete_my_account($1)', [id]);
    // A concurrent request may already have cached a deck under this id: drop it, as
    // DELETE /me does, so nothing keyed by the purged id outlives it. forgetUser logs no id.
    await this.cache?.forgetUser(id);
    throw accountGone();
  }

  private checkOnce(check: ClerkUserCheck, clerkId: string): Promise<boolean> {
    // A Clerk user we just learned is gone: a deleted user's leftover token keeps sending
    // requests for up to its lifetime; don't ask Clerk each time.
    const goneUntil = this.gone.get(clerkId);
    if (goneUntil !== undefined) {
      if (goneUntil > Date.now()) return Promise.resolve(false);
      this.gone.delete(clerkId);
    }
    let pending = this.checking.get(clerkId);
    if (!pending) {
      pending = check(clerkId)
        .then((exists) => {
          if (!exists) this.rememberGone(clerkId);
          return exists;
        })
        .finally(() => this.checking.delete(clerkId));
      this.checking.set(clerkId, pending);
    }
    return pending;
  }

  // In memory only, for seconds: long enough to cover a stale token's burst, never a
  // record of who was deleted. Bounded, oldest first.
  private rememberGone(clerkId: string): void {
    this.gone.delete(clerkId);
    this.gone.set(clerkId, Date.now() + GONE_TTL_MS);
    while (this.gone.size > GONE_MAX) this.gone.delete(this.gone.keys().next().value as string);
  }
}

export const GONE_TTL_MS = 10_000;
const GONE_MAX = 1_000;

/**
 * The 401 for "Clerk no longer has this user", told apart from every other 401 (no token, a
 * token that fails verification) by its code: the web reads account_gone, and only that, as
 * "your account is already deleted". A bare 401 must never be read that way.
 */
export const ACCOUNT_GONE = 'account_gone';
const accountGone = () =>
  new UnauthorizedException({ statusCode: 401, code: ACCOUNT_GONE, message: 'this account no longer exists' });
