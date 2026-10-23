import { Pool } from 'pg';
import { clerkApi } from '../demo/clerk-api';
import { demoConfig, restoreDemoUser } from '../demo/demo-account';

// The public demo's nightly reset (the chart's demo-reset CronJob; demo-account.sh
// reset runs it on demand). First Clerk: every visitor signed out and the account put
// back (demo/demo-account.ts). Then the database: its quests, so the next visitor
// starts with an empty journal. Its taste profile stays (demo-account.sh reset --taste
// clears that by hand).
//
// As larper_demo_reset (migration 0012): it can read users and read and delete quests,
// and nothing else.

export const DELETE_QUESTS_SQL = `DELETE FROM quests WHERE user_id = (SELECT id FROM users WHERE clerk_id = $1)`;

async function main() {
  const cfg = demoConfig(process.env);
  const key = process.env.CLERK_SECRET_KEY?.trim();
  if (!cfg || !key) throw new Error('needs DEMO_CLERK_USER_ID, DEMO_EMAIL and CLERK_SECRET_KEY');

  const clerk = await restoreDemoUser(clerkApi(key), cfg);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const { rowCount } = await pool.query(DELETE_QUESTS_SQL, [cfg.userId]);
    console.log(`demo-reset ${JSON.stringify({ ok: true, clerk, questsDeleted: rowCount ?? 0 })}`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (require.main === module) {
  main().catch((e: Error) => {
    console.error(`demo-reset ${JSON.stringify({ ok: false, error: e.message })}`);
    process.exitCode = 1;
  });
}
