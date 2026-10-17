#!/usr/bin/env bash
# Benchmarks variants of the ranking candidate query directly in Postgres, without
# the API or k6: the same (user, cell) pairs through each variant, one session.
# Reports Postgres CPU per query (the container's cgroup counter, so parallel
# workers and planning count), planning and execution time, and whether each
# variant returns the same candidates as the reference variant (REF, default the
# shipped query, rank-bench/chain-column.sql). Older variants: rank-bench/archive/.
#
#   loadtest/rank-bench.sh [variant ...]        # default: every rank-bench/*.sql
#   N=200 CELLS=path/cells.json loadtest/rank-bench.sh
#
# Pairs: N cell centers drawn from CELLS (cold-cells.js output; default: the newest
# cold-home run, i.e. the cells the clean cache-miss test walked: its 50 homes and
# their neighbours) with onboarded users drawn from taste_profiles, fixed by SEED.
set -uo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1

NS=${NS:-larper}
N=${N:-200}
SEED=${SEED:-0.42}
CHECK_N=${CHECK_N:-40}
REF=${REF:-chain-column}
CELLS=${CELLS:-$(ls -d loadtest/results/cold-home-* 2>/dev/null | tail -1)/cells.json}
[[ -f $CELLS ]] || { echo "no cells file ($CELLS): run cold-run.sh or set CELLS"; exit 1; }
OUT=loadtest/results/rank-bench-$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"
VARIANTS=("$@")
[[ ${#VARIANTS[@]} -gt 0 ]] || VARIANTS=($(ls loadtest/rank-bench/*.sql | xargs -n1 basename | sed 's/\.sql$//'))

pgx() { kubectl -n "$NS" exec -i pg-1 -c postgres -- "$@"; }
psql() { pgx psql -U postgres -d larper -q "$@"; }
cpu_usec() { pgx cat /sys/fs/cgroup/cpu.stat | awk '$1 == "usage_usec" {print $2}'; }

# Pairs.
psql -Atc "SELECT setseed($SEED); SELECT user_id || '|' || vec::text FROM taste_profiles ORDER BY random()" |
  grep '|' >"$OUT/users.txt"
node -e "
const fs = require('fs');
const c = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const users = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => l.split('|'));
let s = Math.floor(Number(process.argv[4]) * 2 ** 31) || 1;
const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
const homes = c.near.map((n, i) => [n.length, i]).sort((a, b) => b[0] - a[0]).slice(0, 50).map((x) => x[1]);
const walk = [...new Set(homes.flatMap((h) => [h, ...c.near[h]]))];
const pairs = [];
for (let i = 0; i < Number(process.argv[3]); i++) {
  const [S, W, N, E] = c.cells[walk[Math.floor(rnd() * walk.length)]];
  const [uid, vec] = users[Math.floor(rnd() * users.length)];
  pairs.push({ uid: Number(uid), vec, lat: +((S + N) / 2).toFixed(6), lng: +((W + E) / 2).toFixed(6), r: 1500 });
}
fs.writeFileSync(process.argv[5], JSON.stringify(pairs));
" "$CELLS" "$OUT/users.txt" "$N" "$SEED" "$OUT/pairs.json"
node -e "const fs = require('fs'); fs.writeFileSync('$OUT/pairs-check.json', JSON.stringify(JSON.parse(fs.readFileSync('$OUT/pairs.json', 'utf8')).slice(0, $CHECK_N)))"

# Reference rows for the equivalence check.
node loadtest/rank-bench.js "loadtest/rank-bench/$REF.sql" "$OUT/pairs-check.json" rows | psql -At >"$OUT/rows-ref.txt"

{
  echo "# Ranking query bench: $(basename "$OUT")"
  echo
  echo "$N pairs (cells from $CELLS, $(wc -l <"$OUT/users.txt") onboarded users, seed $SEED); equivalence vs $REF on the first $CHECK_N."
  echo "Postgres CPU = the pg container's cgroup usage over the run / $N (includes parallel workers, planning, psql)."
  echo
  echo '| variant | Postgres CPU per query (ms) | wall per query (ms) | planning p50 (ms) | execution p50 / p95 (ms) | same candidates |'
  echo '|---|---|---|---|---|---|'
} >"$OUT/report.md"

for v in "${VARIANTS[@]}"; do
  f=loadtest/rank-bench/$v.sql
  node loadtest/rank-bench.js "$f" "$OUT/pairs.json" explain >"$OUT/$v.sql"
  # Warm-up pass (buffers, catalog caches), then the measured pass.
  psql -At <"$OUT/$v.sql" >/dev/null || { echo "$v: failed"; continue; }
  c0=$(cpu_usec); t0=$(date +%s%N)
  psql -At <"$OUT/$v.sql" >"$OUT/$v.explain"
  t1=$(date +%s%N); c1=$(cpu_usec)
  same='–'
  if ! grep -q -i 'EXECUTE' "$f"; then
    node loadtest/rank-bench.js "$f" "$OUT/pairs-check.json" rows | psql -At >"$OUT/rows-$v.txt"
    same=$(node -e "
const fs = require('fs');
const load = (f) => { const m = new Map(); for (const l of fs.readFileSync(f, 'utf8').trim().split('\n')) {
  const [i, id, t] = l.split('|'); if (!m.has(i)) m.set(i, []); m.get(i).push([id, Number(t)]); } return m; };
const a = load(process.argv[1]); const b = load(process.argv[2]);
let bad = 0;
for (const [i, ra] of a) {
  const rb = b.get(i) || [];
  // Ties at the LIMIT boundary may be cut differently: compare the rows strictly
  // above the last taste value, the count, and the taste values themselves.
  const cut = Math.min(...ra.map((r) => r[1]));
  const above = (rs) => rs.filter((r) => r[1] > cut + 1e-12).map((r) => r[0]).sort().join();
  const tastes = (rs) => rs.map((r) => r[1].toFixed(9)).sort().join();
  if (ra.length !== rb.length || above(ra) !== above(rb) || tastes(ra) !== tastes(rb)) bad++;
}
console.log(bad ? 'NO (' + bad + ' of ' + a.size + ' pairs differ)' : 'yes (' + a.size + ' pairs)');
" "$OUT/rows-ref.txt" "$OUT/rows-$v.txt")
  fi
  node -e "
const t = require('fs').readFileSync(process.argv[1], 'utf8');
const get = (re) => [...t.matchAll(re)].map((m) => Number(m[1])).sort((a, b) => a - b);
const plan = get(/Planning Time: ([0-9.]+)/g); const exec = get(/Execution Time: ([0-9.]+)/g);
const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const n = Number(process.argv[2]);
console.log('| ' + process.argv[3] + ' | ' + (Number(process.argv[4]) / 1000 / n).toFixed(1) + ' | ' + (Number(process.argv[5]) / 1e6 / n).toFixed(1) + ' | ' +
  pct(plan, 0.5).toFixed(1) + ' | ' + pct(exec, 0.5).toFixed(1) + ' / ' + pct(exec, 0.95).toFixed(1) + ' | ' + process.argv[6] + ' |');
" "$OUT/$v.explain" "$N" "$v" "$((c1 - c0))" "$((t1 - t0))" "$same" >>"$OUT/report.md"
done
cat "$OUT/report.md"
