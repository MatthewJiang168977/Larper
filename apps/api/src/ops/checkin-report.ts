import { Pool } from 'pg';

// The numbers docs/decisions/0002-checkin-accuracy-tiers.md waits for, from the stored
// check-in attempts (migration 0014, kept 90 days):
//   - how often fixes are rough (accuracy > 100 m), and how many of those end too_rough;
//   - whether Try again recovers them (a too_rough, then an accepted, on one quest);
//   - where accepted check-ins land (distance from the place).
//
// Real check-ins will be few (demo visitors are mostly far from NYC), so every figure
// carries its count, rates carry a 95% interval, and a small sample says so up front.
// The demo account's attempts are counted apart and left out of every figure.
//
//   DATABASE_URL=<owner URL> node dist/ops/checkin-report.js [--days N]
//
// It only reads. The API's role can't read the table (it only writes it), so run it as
// the database owner.

export const ATTEMPTS_SQL = `SELECT quest_id::text AS "questId", outcome, distance_m AS "distanceM",
         accuracy_m AS "accuracyM", demo, created_at AS "createdAt"
  FROM checkin_attempts WHERE created_at >= now() - make_interval(days => $1) ORDER BY created_at, id`;

export interface Attempt {
  questId: string | null;
  outcome: string;
  distanceM: number | null;
  accuracyM: number | null;
  demo: boolean;
  createdAt: Date;
}

/** Below these, rates are anecdotes: the report says so before any number. */
export const SMALL_SAMPLE = { attempts: 30, quests: 12 };
const ROUGH_M = 100;

/** 95% Wilson score interval for k of n, as fractions. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
export function rate(k: number, n: number) {
  if (n === 0) return `0 of 0`;
  const [lo, hi] = wilson(k, n);
  return `${k} of ${n} = ${pct(k / n)} (95% CI ${pct(lo)}-${pct(hi)})`;
}

function quantile(sorted: number[], q: number) {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
}

export function summarize(all: Attempt[], days: number): string[] {
  const real = all.filter((a) => !a.demo);
  const demo = all.length - real.length;
  const quests = new Set(real.map((a) => a.questId).filter(Boolean));
  const out: string[] = [];
  const first = real[0]?.createdAt;
  const last = real.at(-1)?.createdAt;
  const day = (d?: Date) => (d ? d.toISOString().slice(0, 10) : '-');

  out.push(`Check-in attempts, last ${days} days (demo account left out)`);
  out.push(
    `Sample: ${real.length} real attempts on ${quests.size} quests, ${day(first)} to ${day(last)}. Demo account: ${demo} attempts (not counted).`,
  );
  if (real.length < SMALL_SAMPLE.attempts || quests.size < SMALL_SAMPLE.quests) {
    out.push(
      `SMALL SAMPLE: under ${SMALL_SAMPLE.attempts} attempts or ${SMALL_SAMPLE.quests} quests. ` +
        'Read the counts, not the percentages; the intervals show how little they pin down.',
    );
  }
  if (!real.length) return out;

  out.push('', 'Outcomes:');
  const byOutcome = new Map<string, number>();
  for (const a of real) byOutcome.set(a.outcome, (byOutcome.get(a.outcome) ?? 0) + 1);
  for (const [o, k] of [...byOutcome].sort((x, y) => y[1] - x[1])) out.push(`  ${o.padEnd(12)} ${rate(k, real.length)}`);

  const withAcc = real.filter((a) => a.accuracyM !== null);
  const rough = withAcc.filter((a) => a.accuracyM! > ROUGH_M);
  out.push('', `Rough fixes (accuracy over ${ROUGH_M} m), of attempts that reported accuracy:`);
  out.push(`  ${rate(rough.length, withAcc.length)}`);
  out.push(`  of those, ended too_rough: ${rate(rough.filter((a) => a.outcome === 'too_rough').length, rough.length)}`);

  // Per quest, in time order: did an accepted follow a too_rough?
  const seq = new Map<string, string[]>();
  for (const a of real) if (a.questId) seq.set(a.questId, [...(seq.get(a.questId) ?? []), a.outcome]);
  const hadRough = [...seq.values()].filter((s) => s.includes('too_rough'));
  const recovered = hadRough.filter((s) => s.indexOf('accepted') > s.indexOf('too_rough'));
  out.push('', 'Try again after too_rough, per quest:');
  out.push(`  recovered (accepted later): ${rate(recovered.length, hadRough.length)}`);

  const dist = real
    .filter((a) => a.outcome === 'accepted' && a.distanceM !== null)
    .map((a) => a.distanceM!)
    .sort((x, y) => x - y);
  out.push('', `Accepted check-ins, distance from the place (n = ${dist.length}):`);
  if (dist.length) {
    const m = (x: number) => `${Math.round(x)} m`;
    out.push(
      `  median ${m(quantile(dist, 0.5))}, p75 ${m(quantile(dist, 0.75))}, p90 ${m(quantile(dist, 0.9))}, max ${m(dist.at(-1)!)}`,
    );
    if (dist.length < 10) out.push(`  (with ${dist.length} values, p75 and p90 are close to just the largest ones)`);
  }
  return out;
}

async function main() {
  const i = process.argv.indexOf('--days');
  const days = i > 0 ? Number(process.argv[i + 1]) : 90;
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('--days takes 1-90 (rows are kept 90 days)');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    await pool.query('SET default_transaction_read_only = on');
    const { rows } = await pool.query<Attempt>(ATTEMPTS_SQL, [days]);
    console.log(summarize(rows, days).join('\n'));
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (require.main === module) {
  main().catch((e: Error) => {
    console.error(`checkin-report: ${e.message}`);
    process.exit(1);
  });
}
