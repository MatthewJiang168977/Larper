// Generates the SQL for loadtest/rank-bench.sh: one statement per (user, cell) pair
// from a variant file in loadtest/rank-bench/. Placeholders: :uid, :lng, :lat, :r and
// :vec (the user's taste vector as a literal, or NULL). A variant may start with a
// "-- setup:" block (run once per session, e.g. SET or PREPARE) ended by "-- query:".
//   node loadtest/rank-bench.js <variant.sql> <pairs.json> explain|rows
// explain: EXPLAIN (ANALYZE, TIMING OFF) per pair. The query runs in full, rows stay
//   on the server, and the output carries planning and execution time.
// rows: "pair|id|taste" per candidate, to check a variant returns the same set.
const fs = require('fs');

const [variantFile, pairsFile, mode] = process.argv.slice(2);
const text = fs.readFileSync(variantFile, 'utf8');
const [setup, query] = text.includes('-- query:')
  ? text.split('-- query:').map((s) => s.replace('-- setup:', '').trim())
  : ['', text.trim()];
const pairs = JSON.parse(fs.readFileSync(pairsFile, 'utf8'));

const fill = (sql, p) =>
  sql
    .replace(/:uid\b/g, String(p.uid))
    .replace(/:lng\b/g, String(p.lng))
    .replace(/:lat\b/g, String(p.lat))
    .replace(/:r\b/g, String(p.r))
    .replace(/:vec\b/g, p.vec ? `'${p.vec}'::vector` : 'NULL::vector');

const out = ['\\set ON_ERROR_STOP on', '\\pset footer off', '\\pset tuples_only on', '\\pset format unaligned'];
if (setup) out.push(setup.endsWith(';') ? setup : `${setup};`);
pairs.forEach((p, i) => {
  const q = fill(query, p).replace(/;\s*$/, '');
  if (mode === 'explain') out.push(`EXPLAIN (ANALYZE, TIMING OFF) ${q};`);
  else out.push(`SELECT ${i} || '|' || id || '|' || taste FROM (${q}) c;`);
});
console.log(out.join('\n'));
