import { ForbiddenException, Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { CacheService } from '../cache/cache.service';
import { PG } from '../db/db.module';
import { ClerkApiError } from '../demo/clerk-api';
import { isDemoUser } from '../demo/demo-account';
import { CLERK_USER_DELETER, InvalidClerkUserIdError, type ClerkUserDeleter } from './clerk-user-deleter';

/** What went, per kind (the counts the delete_my_* functions return, migration 0020). */
export interface DeletedCounts {
  quests: number;
  checkInAttempts: number;
  hoursAnswers: number;
  savedPlaces: number;
  events: number;
}

export interface HistoryDeleted {
  deleted: DeletedCounts;
}
export interface AccountDeleted {
  deleted: DeletedCounts & { tasteProfile: boolean; account: boolean };
  /**
   * 'deleted': the Clerk user is gone too (a Clerk 404 counts). 'failed': Clerk refused or
   * was unreachable; Larper's data is gone, and repeating the request retries Clerk.
   */
  clerkUser: 'deleted' | 'failed';
}

export const DEMO_REFUSAL = {
  statusCode: 403,
  code: 'demo_account',
  message: 'The demo account is shared and cannot be deleted or cleared. Sign up for your own account to delete your data.',
};

@Injectable()
export class DataDeletionService {
  private readonly log = new Logger('DataDeletion');

  constructor(
    @Inject(PG) private readonly pg: Pool,
    private readonly cache: CacheService,
    @Inject(CLERK_USER_DELETER) private readonly clerkDelete: ClerkUserDeleter | null,
  ) {}

  // The shared demo account is never deleted or cleared by a visitor: everyone who
  // signs in as it would lose it for the next one (the nightly reset owns its data).
  private refuseDemo(clerkId: string) {
    if (isDemoUser(clerkId)) throw new ForbiddenException(DEMO_REFUSAL);
  }

  // Journal, check-ins, hours answers, saved places. Keeps the account and taste.
  async deleteHistory(user: { id: string; clerkId: string }): Promise<HistoryDeleted> {
    this.refuseDemo(user.clerkId);
    const { rows } = await this.pg.query<{ r: DeletedCounts }>('SELECT delete_my_history($1) AS r', [user.id]);
    await this.cache.forgetUser(user.id);
    return { deleted: rows[0].r };
  }

  // Everything, including the users row; then the Clerk user.
  // The database goes first: if Clerk fails, nothing is stranded (the user can repeat the
  // request), whereas a Clerk user deleted before a failed database delete could never
  // sign in to repeat it.
  async deleteAccount(user: { id: string; clerkId: string }): Promise<AccountDeleted> {
    this.refuseDemo(user.clerkId);
    // Without a deleter (PRIVACY_DELETES is not 'all') nothing is purged: half a delete
    // would leave a Clerk user behind with no way to find it.
    const clerkDelete = this.clerkDelete;
    if (!clerkDelete) throw new Error('Clerk user deletion is not configured');
    const { rows } = await this.pg.query<{ r: AccountDeleted['deleted'] }>('SELECT delete_my_account($1) AS r', [user.id]);
    await this.cache.forgetUser(user.id);
    this.log.log('account deleted');

    try {
      await clerkDelete(user.clerkId);
    } catch (err) {
      // Not an outage, so not "failed, retry": an id that can never be deleted is a bug.
      if (err instanceof InvalidClerkUserIdError) {
        this.log.error('Clerk user deletion refused an invalid id');
        throw new InternalServerErrorException();
      }
      // Clerk errors can include the request path and the subject it names.
      const status = err instanceof ClerkApiError ? ` (HTTP ${err.status})` : '';
      this.log.error(`Clerk user deletion failed${status}`);
      return { deleted: rows[0].r, clerkUser: 'failed' };
    }

    // A request that arrived between the purge above and the Clerk deletion still saw a
    // live Clerk user, so ensure() may have made a fresh, empty row for this Clerk id.
    // Clerk now answers 404 for it, so no later request can make another (ensure() checks
    // Clerk before inserting): one more purge here leaves nothing that names the user.
    await this.purgeRecreated(user.clerkId);
    return { deleted: rows[0].r, clerkUser: 'deleted' };
  }

  private async purgeRecreated(clerkId: string): Promise<void> {
    try {
      const { rows } = await this.pg.query<{ id: string }>('SELECT id::text AS id FROM users WHERE clerk_id = $1', [clerkId]);
      for (const { id } of rows) {
        await this.pg.query('SELECT delete_my_account($1)', [id]);
        await this.cache.forgetUser(id);
      }
    } catch (err) {
      // The account and the Clerk user are gone; only a row recreated in the window can be
      // left. Say so without naming anyone.
      this.log.error(`purge of a row recreated during account deletion failed (${(err as Error).constructor.name})`);
    }
  }
}
