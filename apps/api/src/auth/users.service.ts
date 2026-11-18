import { Inject, Injectable, Logger, Optional, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG } from '../db/db.module';
import { isDemoUser } from '../demo/demo-account';
import { CLERK_USER_CHECK, type ClerkUserCheck } from './clerk-user-check';

@Injectable()
export class UsersService {
  private readonly log = new Logger(UsersService.name);
  // First requests of the same brand-new user share one Clerk call.
  private readonly checking = new Map<string, Promise<boolean>>();

  constructor(
    @Inject(PG) private readonly pg: Pool,
    // Null unless PRIVACY_DELETES=all (clerk-user-check.ts).
    @Optional() @Inject(CLERK_USER_CHECK) private readonly clerkCheck: ClerkUserCheck | null = null,
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
      if (!exists) throw new UnauthorizedException();
    }

    const { rows } = await this.pg.query<{ id: string }>(
      `WITH found AS (SELECT id FROM users WHERE clerk_id = $1),
            ins AS (
              INSERT INTO users (clerk_id) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM found)
              ON CONFLICT (clerk_id) DO NOTHING
              RETURNING id)
       SELECT id FROM found UNION ALL SELECT id FROM ins`,
      [clerkId],
    );
    // Two replicas racing on a brand-new user: the loser's insert does nothing.
    if (rows.length) return rows[0].id;
    const again = await this.pg.query<{ id: string }>('SELECT id FROM users WHERE clerk_id = $1', [clerkId]);
    return again.rows[0].id;
  }

  private checkOnce(check: ClerkUserCheck, clerkId: string): Promise<boolean> {
    let pending = this.checking.get(clerkId);
    if (!pending) {
      pending = check(clerkId).finally(() => this.checking.delete(clerkId));
      this.checking.set(clerkId, pending);
    }
    return pending;
  }
}
