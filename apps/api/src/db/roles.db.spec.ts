import { Client, Pool } from 'pg';
import { ARCHIVER_SQL, HEARTBEAT_SQL } from '../ops/backup-check';

// The per-service roles from migration 0010 (docs/decisions/0003-service-db-roles.md).
// The grants must equal the matrix below exactly: a new table or a new query that
// needs a grant fails here until both the migration and this matrix say so. Then each
// role, logged in as itself, is refused what it shouldn't do, and two Postgres rules
// the matrix relies on are checked: identity columns need no sequence grant, and
// foreign-key checks run as the table's owner. The backup check's role is in the
// matrix with no grants at all: it runs its two queries and nothing else.
//
// Needs the owner and every role's URL (CI's db job sets them; db/test has the setup).
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL;
const ROLE_URLS = {
  larper_api: process.env.TEST_API_DATABASE_URL,
  larper_relay: process.env.TEST_RELAY_DATABASE_URL,
  larper_taste: process.env.TEST_TASTE_DATABASE_URL,
  larper_ingest: process.env.TEST_INGEST_DATABASE_URL,
  larper_backup_check: process.env.TEST_BACKUP_CHECK_DATABASE_URL,
};
type Role = keyof typeof ROLE_URLS;
const ROLES = Object.keys(ROLE_URLS) as Role[];
const describeDb = OWNER_URL && ROLES.every((r) => ROLE_URLS[r]) ? describe : describe.skip;

const S = 'SELECT';
const I = 'INSERT';
const U = 'UPDATE';
const D = 'DELETE';
const EXPECTED: Record<Role, Record<string, string[]>> = {
  larper_api: {
    users: [S, I],
    taste_profiles: [S, I, U],
    quests: [S, I, U],
    outbox: [I],
    jobs: [S, I],
    places: [S],
    tags: [S],
    area_stats: [S],
    area_totals: [S],
    areas_ingested: [S],
  },
  larper_relay: {
    outbox: [S, U, D],
  },
  larper_taste: {
    processed_events: [I],
    taste_profiles: [S, I, U],
    places: [S],
  },
  larper_ingest: {
    places: [S, I, U],
    tags: [S, I, U],
    areas_ingested: [S, I, U],
    area_stats: [S, I, D],
    area_totals: [S, I, D],
    jobs: [S, U],
  },
  // templates/backup-check.yaml: no grant. CNPG creates it; no migration does.
  larper_backup_check: {},
};

const ZERO_VEC = 'array_fill(0::real, ARRAY[160])::vector';
const PLACE = `INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
  VALUES ('test-roles-' || gen_random_uuid(), 'Roles Test', ST_SetSRID(ST_MakePoint(0, -60), 4326)::geography,
          '{test}', 'test-roles', '{test}', ${ZERO_VEC}, 1)`;

describeDb('per-service database roles (real database)', () => {
  let owner: Pool;
  const as = {} as Record<Role, Client>;
  let userId: string;

  beforeAll(async () => {
    owner = new Pool({ connectionString: OWNER_URL, max: 2 });
    for (const r of ROLES) {
      as[r] = new Client({ connectionString: ROLE_URLS[r] });
      await as[r].connect();
    }
    // A committed user for the foreign-key checks (other sessions can't see an
    // uncommitted one).
    const u = await owner.query<{ id: string }>(
      `INSERT INTO users (clerk_id) VALUES ('test_roles_' || gen_random_uuid()) RETURNING id::text`,
    );
    userId = u.rows[0].id;
  });

  afterAll(async () => {
    if (userId) await owner.query('DELETE FROM users WHERE id = $1', [userId]);
    await Promise.all(ROLES.map((r) => as[r].end()));
    await owner.end();
  });

  // Runs statements as a role in a transaction that is always rolled back.
  const inTx = async (role: Role, f: (c: Client) => Promise<unknown>) => {
    const c = as[role];
    await c.query('BEGIN');
    try {
      return await f(c);
    } finally {
      await c.query('ROLLBACK');
    }
  };
  const denied = async (role: Role, sql: string, params: unknown[] = []) => {
    const err = await inTx(role, (c) => c.query(sql, params)).then(
      () => null,
      (e: { code?: string }) => e,
    );
    expect({ role, sql, code: err?.code }).toEqual({ role, sql, code: '42501' }); // insufficient_privilege
  };

  it('each role logs in as itself', async () => {
    for (const r of ROLES) {
      const { rows } = await as[r].query<{ u: string }>('SELECT current_user AS u');
      expect(rows[0].u).toBe(r);
    }
  });

  it('grants exactly the table privileges in the matrix', async () => {
    const { rows } = await owner.query<{ grantee: Role; t: string; privs: string[] }>(
      `SELECT grantee, CASE table_schema WHEN 'public' THEN table_name ELSE table_schema || '.' || table_name END AS t,
              array_agg(privilege_type::text ORDER BY privilege_type) AS privs
       FROM information_schema.table_privileges WHERE grantee = ANY($1) GROUP BY 1, 2`,
      [ROLES],
    );
    const actual = Object.fromEntries(ROLES.map((r) => [r, {} as Record<string, string[]>]));
    for (const row of rows) actual[row.grantee][row.t] = row.privs;
    const expected = Object.fromEntries(
      ROLES.map((r) => [
        r,
        Object.fromEntries(Object.entries(EXPECTED[r]).map(([t, p]) => [t, [...p].sort()])),
      ]),
    );
    expect(actual).toEqual(expected);
  });

  it('grants nothing else: no column, sequence or function grants, no memberships or owned objects', async () => {
    const { rows } = await owner.query<{ what: string; role: string; obj: string }>(
      `SELECT 'column' AS what, grantee AS role, table_name || '.' || column_name AS obj
         FROM information_schema.column_privileges c
        WHERE grantee = ANY($1) AND NOT EXISTS (
          SELECT FROM information_schema.table_privileges t
           WHERE t.grantee = c.grantee AND t.table_schema = c.table_schema
             AND t.table_name = c.table_name AND t.privilege_type = c.privilege_type)
       UNION ALL
       SELECT 'usage', grantee, object_type || ' ' || object_name
         FROM information_schema.usage_privileges WHERE grantee = ANY($1)
       UNION ALL
       SELECT 'routine', grantee, routine_name
         FROM information_schema.routine_privileges WHERE grantee = ANY($1)
       UNION ALL
       SELECT 'member of', m.rolname, g.rolname
         FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member JOIN pg_roles g ON g.oid = a.roleid
        WHERE m.rolname = ANY($1)
       UNION ALL
       SELECT 'owns', pg_get_userbyid(relowner), relname::text
         FROM pg_class WHERE pg_get_userbyid(relowner) = ANY($1)`,
      [ROLES],
    );
    expect(rows).toEqual([]);
  });

  it('has no role attributes beyond LOGIN, and DDL rights on nothing', async () => {
    const { rows } = await owner.query(
      `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
              has_database_privilege(rolname, current_database(), 'CREATE') AS create_schema,
              has_database_privilege(rolname, current_database(), 'TEMP') AS temp,
              has_schema_privilege(rolname, 'public', 'CREATE') AS create_in_public,
              has_schema_privilege(rolname, 'public', 'USAGE') AS usage
       FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
      [ROLES],
    );
    const none = { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false };
    const ddl = { create_schema: false, create_in_public: false, usage: true };
    expect(rows).toEqual(
      [...ROLES].sort().map((r) => ({ rolname: r, ...none, ...ddl, temp: r === 'larper_ingest' })),
    );
  });

  describe('denials', () => {
    it('no role can run DDL or TRUNCATE', async () => {
      for (const r of ROLES) {
        await denied(r, 'CREATE TABLE roles_test (id int)');
        await denied(r, 'CREATE SCHEMA roles_test');
        await denied(r, 'ALTER TABLE places ADD COLUMN roles_test int');
        await denied(r, 'DROP TABLE outbox');
        await denied(r, 'TRUNCATE jobs');
        await denied(r, 'CREATE INDEX roles_test ON places (name)');
      }
    });

    it('api: never deletes, and writes no place data', async () => {
      await denied('larper_api', 'DELETE FROM users');
      await denied('larper_api', 'DELETE FROM quests');
      await denied('larper_api', 'UPDATE places SET name = name');
      await denied('larper_api', 'UPDATE users SET clerk_id = clerk_id');
      await denied('larper_api', 'SELECT * FROM outbox');
      await denied('larper_api', 'SELECT * FROM processed_events');
      await denied('larper_api', 'CREATE TEMP TABLE roles_test (id int)');
    });

    it("backup check: its heartbeat and the archiver's status, and no table at all", async () => {
      const c = as.larper_backup_check;
      // What backup-check.ts runs, as it runs it: each statement its own transaction.
      // The insert position: a transaction that wrote nothing else commits like an
      // asynchronous one (the WAL writer flushes the record within wal_writer_delay),
      // so the write position (pg_current_wal_lsn) can lag for a moment.
      const before = await c.query<{ lsn: string }>('SELECT pg_current_wal_insert_lsn()::text AS lsn');
      await c.query(HEARTBEAT_SQL);
      const after = await c.query<{ moved: boolean }>(
        'SELECT pg_current_wal_insert_lsn() > $1::pg_lsn AS moved',
        [before.rows[0].lsn],
      );
      expect(after.rows[0].moved).toBe(true); // the heartbeat wrote WAL
      const { rows } = await c.query(ARCHIVER_SQL);
      expect(rows).toHaveLength(1);

      // Not one privilege on any table or view the schema has.
      const tables = await owner.query<{ t: string }>(
        `SELECT quote_ident(table_name) AS t FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      expect(tables.rows.length).toBeGreaterThan(10);
      const held = await owner.query<{ t: string }>(
        `SELECT t FROM unnest($1::text[]) AS t
          WHERE has_table_privilege('larper_backup_check', t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')`,
        [tables.rows.map((r) => r.t)],
      );
      expect(held.rows).toEqual([]);
      await denied('larper_backup_check', 'SELECT 1 FROM places LIMIT 1');
      await denied('larper_backup_check', 'SELECT 1 FROM users LIMIT 1');
      await denied('larper_backup_check', `INSERT INTO users (clerk_id) VALUES ('test_x')`);
      await denied('larper_backup_check', 'UPDATE quests SET status = status');
      await denied('larper_backup_check', 'DELETE FROM outbox');
      await denied('larper_backup_check', 'CREATE TEMP TABLE roles_test (id int)');

      const lim = await owner.query<{ n: number }>(
        `SELECT rolconnlimit AS n FROM pg_roles WHERE rolname = 'larper_backup_check'`,
      );
      expect(lim.rows[0].n).toBe(1);
    });

    it('outbox-relay: only the outbox, and it never writes events', async () => {
      await denied('larper_relay', 'SELECT * FROM users');
      await denied('larper_relay', 'SELECT * FROM quests');
      await denied('larper_relay', 'SELECT * FROM taste_profiles');
      await denied('larper_relay', `INSERT INTO outbox (topic, key, type, payload) VALUES ('t', 'k', 'x', '\\x00')`);
    });

    it('taste-worker: no users, quests or place writes', async () => {
      await denied('larper_taste', 'SELECT * FROM users');
      await denied('larper_taste', 'SELECT * FROM quests');
      await denied('larper_taste', `UPDATE quests SET status = 'completed'`);
      await denied('larper_taste', 'UPDATE places SET tag_vec = tag_vec');
      await denied('larper_taste', 'DELETE FROM taste_profiles');
      // Pruning isn't granted yet (docs/decisions/0003).
      await denied('larper_taste', 'DELETE FROM processed_events');
    });

    it('ingest-worker: no user data, and deletes only its stats', async () => {
      await denied('larper_ingest', 'SELECT * FROM users');
      await denied('larper_ingest', 'SELECT * FROM taste_profiles');
      await denied('larper_ingest', 'SELECT * FROM quests');
      await denied('larper_ingest', 'SELECT * FROM outbox');
      await denied('larper_ingest', 'DELETE FROM places');
      await denied('larper_ingest', 'DELETE FROM jobs');
      await denied('larper_ingest', `INSERT INTO jobs (queue, dedupe_key, payload) VALUES ('q', 'k', '{}')`);
    });
  });

  describe('what each role must still be able to do', () => {
    it('identity columns need no sequence grant (api: users; ingest: places)', async () => {
      await inTx('larper_api', async (c) => {
        const { rows } = await c.query(
          `INSERT INTO users (clerk_id) VALUES ('test_roles_' || gen_random_uuid()) RETURNING id`,
        );
        expect(rows).toHaveLength(1);
      });
      await inTx('larper_ingest', async (c) => {
        expect((await c.query(`${PLACE} RETURNING id`)).rows).toHaveLength(1);
      });
    });

    it("foreign-key checks run as the owner: taste-worker writes a profile for a user it can't read", async () => {
      await inTx('larper_taste', async (c) => {
        await c.query(
          `INSERT INTO taste_profiles (user_id, vec, source, updated_at) VALUES ($1, ${ZERO_VEC}, 'events', now())
           ON CONFLICT (user_id) DO UPDATE SET vec = EXCLUDED.vec, source = 'events', updated_at = now()`,
          [userId],
        );
      });
      // ...and the check still runs: a missing user is a foreign-key violation, not a
      // permission error.
      const err = await inTx('larper_taste', (c) =>
        c.query(`INSERT INTO taste_profiles (user_id, vec, source) VALUES (-1, ${ZERO_VEC}, 'events')`),
      ).catch((e: { code?: string }) => e);
      expect((err as { code?: string }).code).toBe('23503');
    });

    it("the outbox-relay's poll, mark-sent and prune", async () => {
      await inTx('larper_relay', async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `SELECT id, topic, key, type, payload FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT $1
           FOR UPDATE SKIP LOCKED`,
          [100],
        );
        await c.query('UPDATE outbox SET sent_at = now() WHERE id = ANY($1)', [rows.map((r) => r.id)]);
        await c.query(`DELETE FROM outbox WHERE sent_at < now() - $1::interval`, ['168 hours']);
      });
    });

    it("the taste-worker's dedupe, profile lock and place read", async () => {
      await inTx('larper_taste', async (c) => {
        await c.query(
          `INSERT INTO processed_events (consumer, event_id) VALUES ($1, gen_random_uuid()) ON CONFLICT DO NOTHING`,
          ['taste-worker'],
        );
        await c.query('SELECT vec::text FROM taste_profiles WHERE user_id = $1 FOR UPDATE', [userId]);
        await c.query('SELECT tag_vec::text FROM places WHERE id = $1', [0]);
      });
    });

    it("the ingest-worker's COPY stage (a temporary table) and stats rewrite", async () => {
      await inTx('larper_ingest', async (c) => {
        await c.query('CREATE TEMP TABLE stage (LIKE places INCLUDING DEFAULTS) ON COMMIT DROP');
        await c.query(`DELETE FROM area_stats WHERE geohash6 LIKE 'zzzzz%'`);
        await c.query(`INSERT INTO area_totals (geohash6, places) VALUES ('zzzzzz', 0)`);
        await c.query('SELECT pg_advisory_xact_lock(1)');
      });
    });

    it('the API enqueues an ingest and writes an outbox event', async () => {
      await inTx('larper_api', async (c) => {
        // As jobs/job-queue.ts and events/outbox.ts write them: no RETURNING, which
        // would need SELECT on outbox.
        await c.query(
          `INSERT INTO jobs (queue, dedupe_key, payload) VALUES ('test-roles', 'k', '{}')
           ON CONFLICT (queue, dedupe_key) WHERE status IN ('queued', 'running') DO NOTHING`,
        );
        await c.query(`INSERT INTO outbox (topic, key, type, payload) VALUES ('user.events', '0', 'x', '\\x00')`);
      });
    });
  });
});
