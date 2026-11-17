// Opening-hours pilot, step 1 (read-only): export the places the owner should verify by hand.
//
//   DATABASE_URL=postgres://... node apps/api/dist/hours-pilot/candidates.cli.js [--out FILE] [--per-area N] [--areas FILE]
//   (or scripts/hours-pilot-candidates, which builds first). See docs/plans/hours-pilot.md.
//
// One transaction, SET TRANSACTION READ ONLY: Postgres itself refuses any write. Writes a CSV
// (default pilot/hours-candidates-YYYY-MM-DD.csv, gitignored) and prints a count per area.

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { Pool } from 'pg';
import { BLOCKED_CATEGORIES, MIN_CONFIDENCE } from '../quests/eligibility';
import { defaultOutputPath, parseFocusAreas, PilotPlace, rankPilotCandidates, toCsv } from './candidates';

type Row = Omit<PilotPlace, 'address'>;

// Same pre-filter as quests.service candidates(): confidence as a float4, blocked names, not
// location_suspect. applyStaticGate then re-applies the rules (and the dedupe) in TypeScript.
// Places that already carry a 'manual' regular schedule come back marked `verified`: they
// still take part in the same-name dedupe (as they do in the API), and are left out of the
// CSV only after it (rankPilotCandidates). A place on the border of two polygons is listed
// once, under the first area in the file.
export const CANDIDATES_SQL = `
  SELECT DISTINCT ON (p.id)
         p.id::text AS id, p.name, ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lng,
         p.categories, p.categories[array_length(p.categories, 1)] AS category, p.tags,
         p.confidence::float8 AS confidence, p.chain_locations AS "chainLocations",
         p.website, p.phone, a.name AS neighborhood,
         EXISTS (SELECT FROM place_hours_facts f
                 WHERE f.place_id = p.id AND f.kind = 'schedule' AND f.service = 'regular' AND f.source = 'manual') AS verified
  FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS a(name, gj, ord)
  JOIN places p ON ST_Intersects(p.geom::geometry, ST_SetSRID(ST_GeomFromGeoJSON(a.gj), 4326))
  WHERE p.location_suspect IS NULL
    AND p.confidence >= $3::real
    AND NOT EXISTS (SELECT FROM unnest(p.categories) c WHERE lower(c) = ANY($4::text[]))
  ORDER BY p.id, a.ord`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const perArea = Number(arg('--per-area') ?? 50);
  if (!Number.isInteger(perArea) || perArea < 1) throw new Error('--per-area must be a positive integer');
  const areasFile = arg('--areas') ?? join(__dirname, '../../../../data/focus-neighborhoods.geojson');
  const out = arg('--out') ?? defaultOutputPath();
  const areas = parseFocusAreas(readFileSync(areasFile, 'utf8'));

  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  let rows: Row[];
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    ({ rows } = await client.query<Row>(CANDIDATES_SQL, [
      areas.map((a) => a.name),
      areas.map((a) => a.geometry),
      MIN_CONFIDENCE,
      BLOCKED_CATEGORIES,
    ]));
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }

  const ranked = rankPilotCandidates(
    rows.map((r) => ({ ...r, address: null })),
    perArea,
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, toCsv(ranked), 'utf8');
  console.log(`${rows.length} places in the focus areas passed the SQL pre-filter; ${ranked.length} written to ${out}`);
  for (const a of areas) console.log(`  ${a.name}: ${ranked.filter((p) => p.neighborhood === a.name).length}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
