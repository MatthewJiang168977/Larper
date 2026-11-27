// The places the offline eval ranks, from a database, in a read-only transaction:
//
//   DATABASE_URL=... node dist/ops/eval-snapshot.js --out ../../pilot/eval-places.json
//
// The file is Overture data: keep it out of the repository (pilot/ is gitignored).

import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { Pool, type PoolClient } from 'pg';
import { POINTS, RADIUS_M, type EvalPlace } from '../eval/eval';

// Everything within the radius of any point, and a margin for the cell center and the area
// stats' cells around it. Suspect locations are left out, as the ranker leaves them out.
const SQL = `
  SELECT p.id::text, p.overture_id AS "overtureId", p.name, ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lng,
         p.categories, p.tags, p.confidence::float8 AS confidence, p.chain_locations AS "chainLocations",
         p.tag_vec::text AS vec
  FROM places p
  WHERE p.location_suspect IS NULL
    AND EXISTS (SELECT FROM unnest($1::float8[], $2::float8[]) AS o(lng, lat)
                WHERE ST_DWithin(p.geom, ST_SetSRID(ST_MakePoint(o.lng, o.lat), 4326)::geography, $3))
  ORDER BY p.id`;

export async function snapshot(db: Pick<PoolClient, 'query'>): Promise<EvalPlace[]> {
  const tags = await db.query<{ slot: number; tag: string }>('SELECT slot, tag FROM tags');
  const tagOf = new Map(tags.rows.map((r) => [r.slot, r.tag]));
  const { rows } = await db.query<Omit<EvalPlace, 'vec'> & { vec: string }>(SQL, [
    POINTS.map((p) => p.lng),
    POINTS.map((p) => p.lat),
    RADIUS_M + 2000,
  ]);
  return rows.map((r) => ({
    ...r,
    vec: Object.fromEntries(
      (JSON.parse(r.vec) as number[]).flatMap((w, slot) => (w && tagOf.has(slot) ? [[tagOf.get(slot)!, w]] : [])),
    ),
  }));
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const i = process.argv.indexOf('--out');
  if (i < 0 || !process.argv[i + 1]) throw new Error('--out FILE is required');
  const out = process.argv[i + 1];
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const places = await snapshot(client);
    await client.query('ROLLBACK');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(places), 'utf8');
    console.log(`${places.length} places written to ${out}`);
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
