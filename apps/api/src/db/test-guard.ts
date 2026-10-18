import type { Pool, PoolClient } from 'pg';

// For database tests that write: refuse to run against anything that isn't a throwaway
// database. Those tests insert quests and outbox rows and delete them afterwards, but a
// live stack's outbox-relay would publish the rows to Kafka first (events for a user
// that's about to vanish), and a real database has real users' data next to them.
//
// "Disposable" means: no users or places the tests didn't create, no outbox-relay
// connected, and no outbox rows sent recently (a relay that's between polls, or one
// connecting under another name). CI's database passes: it's freshly migrated, and the
// Go integration tests that run before clean up after themselves.

type Queryable = Pick<Pool | PoolClient, 'query'>;

export interface GuardOptions {
  /** application_name values that mean "a relay is connected" (workers set it). */
  relayNames?: string[];
  /** How far back a sent outbox row counts as relay activity. */
  recentlySent?: string;
}

export async function assertDisposableDatabase(db: Queryable, test: string, opts: GuardOptions = {}) {
  const relayNames = opts.relayNames ?? ['outbox-relay'];
  const { rows } = await db.query<{
    db: string;
    host: string | null;
    users: number;
    places: number;
    sent: number;
  }>(
    `SELECT current_database() AS db, host(inet_server_addr()) AS host,
       (SELECT count(*)::int FROM users WHERE clerk_id NOT LIKE 'test\\_%') AS users,
       (SELECT count(*)::int FROM places WHERE overture_id NOT LIKE 'test-%') AS places,
       (SELECT count(*)::int FROM outbox WHERE sent_at > now() - $1::interval) AS sent`,
    [opts.recentlySent ?? '1 hour'],
  );
  const r = rows[0];
  // The relay's own sessions: by name (workers set application_name), or by its poll
  // query, visible when the test connects as the same role.
  const relays = await db.query<{ pid: number; name: string }>(
    `SELECT pid, application_name AS name FROM pg_stat_activity
     WHERE pid <> pg_backend_pid() AND datname = current_database()
       AND (application_name = ANY($1)
            OR query ILIKE '%FROM outbox%SKIP LOCKED%' OR query ILIKE 'UPDATE outbox SET sent_at%')`,
    [relayNames],
  );

  const problems: string[] = [];
  if (r.users) problems.push(`${r.users} user(s) the tests didn't create`);
  if (r.places) problems.push(`${r.places} place(s) the tests didn't create`);
  for (const s of relays.rows) problems.push(`an outbox relay is connected (pid ${s.pid}, application_name "${s.name}")`);
  if (r.sent) problems.push(`${r.sent} outbox row(s) sent in the last ${opts.recentlySent ?? '1 hour'}: a relay is running`);
  if (problems.length) {
    throw new Error(
      `${test} refuses to run: TEST_DATABASE_URL (database "${r.db}" on ${r.host ?? 'a local socket'}) ` +
        `doesn't look like a disposable test database:\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        `\nIt writes quests and outbox rows, which a running relay would publish. Point TEST_DATABASE_URL ` +
        `at a throwaway Postgres with the migrations applied (what CI's db job does).`,
    );
  }
}
