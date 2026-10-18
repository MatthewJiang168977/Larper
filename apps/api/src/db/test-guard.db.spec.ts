import { randomUUID } from 'crypto';
import { Client, Pool, PoolClient } from 'pg';
import { createPool } from './db.module';
import { assertDisposableDatabase } from './test-guard';

// The guard that keeps writing DB tests off live stacks. Each case is invisible to the
// other spec files Jest runs at the same time: data goes in a transaction that's rolled
// back (the guard reads through the same connection), and the pretend relay connects
// under a name only this file looks for.
const URL = process.env.TEST_DATABASE_URL;
const describeDb = URL ? describe : describe.skip;

describeDb('assertDisposableDatabase (real database)', () => {
  let pool: Pool;
  let tx: PoolClient;

  beforeAll(() => {
    pool = createPool(URL);
  });
  afterAll(() => pool.end());
  beforeEach(async () => {
    tx = await pool.connect();
    await tx.query('BEGIN');
  });
  afterEach(async () => {
    await tx.query('ROLLBACK');
    tx.release();
  });

  it('passes on a clean, migrated database', async () => {
    await expect(assertDisposableDatabase(tx, 'guard test')).resolves.toBeUndefined();
  });

  it('passes with rows the tests create themselves', async () => {
    await tx.query(`INSERT INTO users (clerk_id) VALUES ('test_guard_' || gen_random_uuid())`);
    await expect(assertDisposableDatabase(tx, 'guard test')).resolves.toBeUndefined();
  });

  it('refuses a database with real users', async () => {
    await tx.query(`INSERT INTO users (clerk_id) VALUES ('user_' || gen_random_uuid())`);
    await expect(assertDisposableDatabase(tx, 'guard test')).rejects.toThrow(
      /guard test refuses to run: .*\n {2}- 1 user\(s\) the tests didn't create/,
    );
  });

  it('refuses a database with real places', async () => {
    await tx.query(
      `INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
       VALUES ('08f2a1', 'Real Cafe', ST_SetSRID(ST_MakePoint(-73.99, 40.73), 4326)::geography,
               '{cafe}', 'real-cafe', '{cafe}', array_fill(0, ARRAY[160])::vector, 0.9)`,
    );
    await expect(assertDisposableDatabase(tx, 'guard test')).rejects.toThrow("1 place(s) the tests didn't create");
  });

  it('refuses when outbox rows were sent recently (a relay is running)', async () => {
    await tx.query(
      `INSERT INTO outbox (topic, key, type, payload, sent_at) VALUES ('user.events', '1', 'x', '\\x00', now())`,
    );
    await expect(assertDisposableDatabase(tx, 'guard test')).rejects.toThrow(
      '1 outbox row(s) sent in the last 1 hour: a relay is running',
    );
  });

  it('refuses while an outbox relay is connected', async () => {
    const name = `outbox-relay-guard-${randomUUID().slice(0, 8)}`;
    const relay = new Client({ connectionString: URL, application_name: name });
    await relay.connect();
    try {
      await expect(assertDisposableDatabase(tx, 'guard test', { relayNames: [name] })).rejects.toThrow(
        new RegExp(`an outbox relay is connected \\(pid \\d+, application_name "${name}"\\)`),
      );
    } finally {
      await relay.end();
    }
  });

  it('names the database and host, never the URL (it holds the password)', async () => {
    await tx.query(`INSERT INTO users (clerk_id) VALUES ('user_' || gen_random_uuid())`);
    const err = await assertDisposableDatabase(tx, 'guard test').catch((e: Error) => e);
    expect((err as Error).message).toMatch(/database "\w+" on /);
    const password = new globalThis.URL(URL!).password;
    if (password) expect((err as Error).message).not.toContain(password);
  });
});
