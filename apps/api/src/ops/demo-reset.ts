import { Pool } from 'pg';
import { clerkApi } from '../demo/clerk-api';
import { DEMO_TASTE, demoConfig, restoreDemoUser } from '../demo/demo-account';
import { VIBE_CARDS } from '../profile/cards';
import { TAG_DIMS } from '../profile/tags.service';
import { seedTasteVector, toVectorLiteral } from '../profile/taste';

// The public demo's nightly reset (the chart's demo-reset CronJob; demo-account.sh
// reset runs it on demand). First Clerk: every visitor signed out and the account put
// back (demo/demo-account.ts). Then the database: its quests deleted, so the next
// visitor starts with an empty journal, and its taste back to the baseline
// (DEMO_TASTE), as if onboarded with those cards. A new updated_at is a new taste
// version, so no deck cached for the day's taste is served.
//
// As larper_demo_reset (migrations 0012, 0013): it reads users and tags, deletes
// quests, and writes taste profiles, and nothing else.

export const DELETE_QUESTS_SQL = `DELETE FROM quests WHERE user_id = (SELECT id FROM users WHERE clerk_id = $1)`;
export const TAGS_SQL = 'SELECT slot, tag FROM tags';
// No row when the account has never called the API (no users row): nothing to restore.
export const RESTORE_TASTE_SQL = `INSERT INTO taste_profiles (user_id, vec, source)
  SELECT id, $2::vector, 'onboarding' FROM users WHERE clerk_id = $1
  ON CONFLICT (user_id) DO UPDATE SET vec = EXCLUDED.vec, source = EXCLUDED.source, updated_at = now()`;

/** DEMO_TASTE as a taste vector, given the tags table's slots. */
export function demoTasteVector(slots: Map<string, number>): number[] {
  const card = (id: string) => {
    const c = VIBE_CARDS.find((v) => v.id === id);
    if (!c) throw new Error(`DEMO_TASTE: unknown card ${id}`);
    return c;
  };
  const vec = seedTasteVector(DEMO_TASTE.liked.map(card), DEMO_TASTE.passed.map(card), (t) => slots.get(t), TAG_DIMS);
  if (!vec) throw new Error('DEMO_TASTE likes no card');
  return vec;
}

async function main() {
  const cfg = demoConfig(process.env);
  const key = process.env.CLERK_SECRET_KEY?.trim();
  if (!cfg || !key) throw new Error('needs DEMO_CLERK_USER_ID, DEMO_EMAIL and CLERK_SECRET_KEY');

  const clerk = await restoreDemoUser(clerkApi(key), cfg);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const { rowCount: questsDeleted } = await pool.query(DELETE_QUESTS_SQL, [cfg.userId]);
    const { rows } = await pool.query<{ slot: number; tag: string }>(TAGS_SQL);
    if (!rows.length) throw new Error('no tags yet (load-places has not run)');
    const vec = demoTasteVector(new Map(rows.map((r) => [r.tag, r.slot])));
    const { rowCount: taste } = await pool.query(RESTORE_TASTE_SQL, [cfg.userId, toVectorLiteral(vec)]);
    console.log(
      `demo-reset ${JSON.stringify({ ok: true, clerk, questsDeleted: questsDeleted ?? 0, tasteRestored: taste === 1 })}`,
    );
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
