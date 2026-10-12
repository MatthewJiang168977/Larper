import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG } from '../db/db.module';

@Injectable()
export class UsersService {
  constructor(@Inject(PG) private readonly pg: Pool) {}

  // Returns our user id for a Clerk user, creating the row on first sight.
  // Read-first so the common case is a plain index lookup, not a write.
  async ensure(clerkId: string): Promise<string> {
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
}
