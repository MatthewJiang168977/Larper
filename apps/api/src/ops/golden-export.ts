// Writes data/golden-places.csv from the curation page's verdicts (latest per place). Reads
// only, in a read-only transaction:
//
//   DATABASE_URL=... node dist/ops/golden-export.js [--notes] [--out FILE]
//
// THE REPOSITORY IS PUBLIC: insider notes are written only with --notes.

import { writeFileSync } from 'fs';
import { join } from 'path';
import { Pool, type PoolClient } from 'pg';
import { VERDICTS, type Verdict } from '../curation/place-facts';
import { GoldenRow, RATING_OF, toGoldenCsv } from '../eval/golden';

const SQL = `
  SELECT p.overture_id AS "overtureId", v.kind, to_char(v.created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS "ratedAt",
         (SELECT note FROM place_facts n WHERE n.place_id = p.id AND n.kind = 'note'
          ORDER BY n.created_at DESC, n.id DESC LIMIT 1) AS note
  FROM (SELECT DISTINCT ON (place_id) place_id, kind, created_at FROM place_facts
        WHERE kind = ANY($1::text[]) ORDER BY place_id, created_at DESC, id DESC) v
  JOIN places p ON p.id = v.place_id`;

export async function goldenRows(db: Pick<PoolClient, 'query'>, notes: boolean): Promise<GoldenRow[]> {
  const { rows } = await db.query<{ overtureId: string; kind: Verdict; ratedAt: string; note: string | null }>(SQL, [VERDICTS]);
  return rows.map((r) => ({
    overtureId: r.overtureId,
    rating: RATING_OF[r.kind],
    note: notes ? (r.note ?? '') : '',
    ratedAt: r.ratedAt,
  }));
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const i = process.argv.indexOf('--out');
  const out = i >= 0 ? process.argv[i + 1] : join(__dirname, '../../../../data/golden-places.csv');
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const rows = await goldenRows(client, process.argv.includes('--notes'));
    await client.query('ROLLBACK');
    writeFileSync(out, toGoldenCsv(rows), 'utf8');
    console.log(`${rows.length} rated places written to ${out}`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
