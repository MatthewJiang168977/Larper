import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { createPool } from '../db/db.module';
import { TagsService } from '../profile/tags.service';
import type { AreasService } from './areas.service';
import { cellOf } from './geo';
import { QuestsService } from './quests.service';
import { Candidate, mmr, Scored } from './scoring';

// Against a real database with places and onboarded users, so skipped unless
// TEST_DATABASE_URL is set (e.g. the k3d Postgres through a port-forward; see the
// README). Checks the two-phase candidate query against the query it replaced, on the
// 200 (user, cell) pairs loadtest/rank-bench.sh measured, and that the API pool's
// no-parallel setting stays on the API's own connections.
//
// The old query had no tiebreak, and in dense cells thousands of places share the
// lowest taste, so which of them made the 3000 cut depended on the plan (it changed
// between a parallel and a serial run). Two checks follow from that:
// - with only an id tiebreak added, the old query and the new one agree exactly:
//   candidates, ranked top 200 and deck;
// - the old query as it was agrees with the new one on every candidate above the tie,
//   and on how many tied ones there are.
const URL = process.env.TEST_DATABASE_URL;
const describeDb = URL ? describe : describe.skip;
// The 200-pair checks need the NYC places and the bench's onboarded users. CI runs
// against an empty, freshly migrated database and sets TEST_NYC_DATA=0 to skip them.
const itNyc = process.env.TEST_NYC_DATA === '0' ? it.skip : it;

const BENCH = join(__dirname, '../../../../loadtest/rank-bench');
const PAIRS: { uid: number; lat: number; lng: number; r: number }[] = JSON.parse(
  readFileSync(join(BENCH, 'pairs.json'), 'utf8'),
);
// The replaced query, as the bench ran it, with the bench's placeholders as
// parameters in the order candidates() passes them. It read the chain size from
// chain_stats, which migration 0009 dropped: here it counts the chain's places live,
// which is what chain_stats held (0008 found 0 mismatches before backfilling).
const CHAIN_STATS_JOIN = 'LEFT JOIN chain_stats c ON c.chain_key = p.chain_key';
const LIVE_CHAIN_JOIN = `LEFT JOIN LATERAL (SELECT count(*)::int AS locations FROM places p2
  WHERE p2.chain_key = p.chain_key) c ON true`;
const OLD_SQL = readFileSync(join(BENCH, 'archive/current.sql'), 'utf8')
  .replace(/^--.*$/gm, '')
  .replace(/:uid\b/g, '$1')
  .replace(/:lng\b/g, '$2')
  .replace(/:lat\b/g, '$3')
  .replace(/:r\b/g, '$4')
  .replace(CHAIN_STATS_JOIN, LIVE_CHAIN_JOIN);
if (OLD_SQL.includes('chain_stats')) throw new Error('archive/current.sql: chain_stats join not replaced');
const OLD_SQL_TIEBREAK = OLD_SQL.replace('ORDER BY taste DESC', 'ORDER BY taste DESC, p.id');
const DECK_SIZE = 10;

type Ranker = {
  candidates(userId: string, lat: number, lng: number, radiusM: number): Promise<Candidate[]>;
  rank(...args: [string, number[] | null, number, number, string, number, boolean]): Promise<Scored[]>;
  loadTaste(userId: string): Promise<{ vec: number[] | null }>;
};

// Ties in taste at the LIMIT can be cut differently by any two runs of either query:
// the rows above the lowest taste must match exactly, and the tied rows in number.
function sameCandidates(a: Candidate[], b: Candidate[]) {
  if (a.length !== b.length) return 'count';
  const cut = Math.min(...a.map((c) => c.taste));
  const above = (cs: Candidate[]) =>
    cs.filter((c) => c.taste > cut).sort((x, y) => Number(x.id) - Number(y.id));
  if (JSON.stringify(above(a)) !== JSON.stringify(above(b))) return 'rows';
  const tastes = (cs: Candidate[]) => cs.map((c) => c.taste).sort().join();
  return tastes(a) === tastes(b) ? null : 'tied rows';
}

const ranked = (xs: Scored[]) => xs.map((x) => `${x.id}:${x.score}`).join();

describeDb('two-phase candidate query (real database)', () => {
  let pool: Pool;
  let plain: Pool;
  let next: Ranker;
  let prev: Ranker;

  beforeAll(async () => {
    pool = createPool(URL);
    // Same user, without the API pool's options: what the workers and batch jobs get.
    plain = new Pool({ connectionString: URL, max: 1 });
    const tags = new TagsService(pool);
    const cache = { getOrSet: async <T>(_k: string, _t: number, f: () => Promise<T>) => ({ value: await f(), hit: false }) };
    const make = () =>
      new QuestsService(pool, cache as unknown as CacheService, tags, {} as AreasService) as unknown as Ranker;
    next = make();
    prev = make();
    prev.candidates = async (userId, lat, lng, radiusM) =>
      (await pool.query<Candidate>(OLD_SQL_TIEBREAK, [userId, lng, lat, radiusM])).rows;
  });

  afterAll(async () => {
    await pool.end();
    await plain.end();
  });

  // candidates() reads the chain size stored on each place (migration 0008, kept
  // current by stats.Recompute): it must equal a live count of the chain's places.
  it('has the live chain size on every place', async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM places p
       JOIN (SELECT chain_key, count(*)::int AS live FROM places GROUP BY 1) c USING (chain_key)
       WHERE p.chain_locations <> c.live`,
    );
    expect(rows[0].n).toBe('0');
  });

  it('turns parallel workers off on API connections only', async () => {
    const show = async (p: Pool) => (await p.query('SHOW max_parallel_workers_per_gather')).rows[0].max_parallel_workers_per_gather;
    expect(await show(pool)).toBe('0');
    expect(await show(plain)).not.toBe('0');
  });

  itNyc('matches the old query plus an id tiebreak exactly: candidates, top 200, deck', async () => {
    const diffs: string[] = [];
    for (const [i, p] of PAIRS.entries()) {
      const uid = String(p.uid);
      const { vec } = await next.loadTaste(uid);
      if (!vec) throw new Error(`pair ${i}: user ${uid} has no taste profile in this database`);
      const [a, b] = await Promise.all([
        prev.candidates(uid, p.lat, p.lng, p.r),
        next.candidates(uid, p.lat, p.lng, p.r),
      ]);
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`pair ${i}: candidates differ`);

      const { cell } = cellOf(p.lat, p.lng);
      const [ra, rb] = await Promise.all([
        prev.rank(uid, vec, p.lat, p.lng, cell, p.r, false),
        next.rank(uid, vec, p.lat, p.lng, cell, p.r, false),
      ]);
      if (ranked(ra) !== ranked(rb)) diffs.push(`pair ${i}: ranked top 200 differs`);
      const da = mmr(ra, DECK_SIZE).map((x) => x.id).join();
      const db = mmr(rb, DECK_SIZE).map((x) => x.id).join();
      if (da !== db) diffs.push(`pair ${i}: deck differs`);
    }
    expect(diffs).toEqual([]);
  }, 600_000);

  itNyc('matches the old query as it was everywhere but the tie at the limit', async () => {
    const diffs: string[] = [];
    let ties = 0;
    for (const [i, p] of PAIRS.entries()) {
      const uid = String(p.uid);
      const [a, b] = await Promise.all([
        pool.query<Candidate>(OLD_SQL, [uid, p.lng, p.lat, p.r]).then((r) => r.rows),
        next.candidates(uid, p.lat, p.lng, p.r),
      ]);
      const cand = sameCandidates(a, b);
      if (cand) diffs.push(`pair ${i}: candidates differ (${cand})`);
      if (a.length === 3000 && a.filter((c) => c.taste === a[a.length - 1].taste).length > 1) ties++;
    }
    console.log(`${ties} of ${PAIRS.length} pairs have several places tied at the 3000 limit`);
    expect(diffs).toEqual([]);
  }, 600_000);
});
