// The pick-quality funnel (docs/plans/industry-ready-plan.md, "Metrics"; reads only):
//
//   DATABASE_URL=... ADMIN_USER_IDS=... DEMO_CLERK_USER_ID=... node dist/ops/funnel-report.js [--days N] [--exclude ID,...]
//
// Counts people and quests, never places. Left out: the owner and admins (ADMIN_USER_IDS and
// --exclude, Larper or Clerk user ids), the shared demo account, and simulated check-ins.
// History a user deleted is gone from these numbers too.

import { Pool, type PoolClient } from 'pg';
import { adminIds } from '../curation/admin.guard';

export const FUNNEL_SQL = `
  SELECT q.user_id::text AS "userId", q.created_at AS "offeredAt", q.accepted_at AS "acceptedAt",
         CASE WHEN q.status = 'completed' THEN coalesce(q.completed_at, q.updated_at) END AS "completedAt",
         q.worth_it AS "worthIt",
         (SELECT h.was_open FROM place_hours_facts h WHERE h.quest_id = q.id AND h.kind = 'observation') AS "wasOpen"
  FROM quests q JOIN users u ON u.id = q.user_id
  WHERE NOT coalesce((q.reasons->>'simulated')::boolean, false)
    AND NOT (u.id::text = ANY($1::text[]) OR u.clerk_id = ANY($1::text[]))`;

export interface FunnelQuest {
  userId: string;
  offeredAt: Date;
  acceptedAt: Date | null;
  completedAt: Date | null;
  worthIt: 'yes' | 'meh' | 'no' | null;
  wasOpen: boolean | null;
}

const DAY_MS = 86_400_000;
const nyDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The Monday (New York) of the week an instant falls in, as YYYY-MM-DD. */
export function weekOf(at: Date): string {
  const d = new Date(`${nyDay.format(at)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const nextWeek = (week: string) => new Date(Date.parse(`${week}T00:00:00Z`) + 7 * DAY_MS).toISOString().slice(0, 10);

/** Of the people who accepted or checked in during week N, how many did either in week N+1. */
export function weeklyReturn(quests: readonly FunnelQuest[], now: Date): { week: string; active: number; returned: number }[] {
  const weeks = new Map<string, Set<string>>();
  for (const q of quests) {
    for (const at of [q.acceptedAt, q.completedAt]) {
      if (!at) continue;
      const w = weekOf(at);
      weeks.set(w, (weeks.get(w) ?? new Set()).add(q.userId));
    }
  }
  // Only weeks whose following week is over: a week in progress would read as people leaving.
  return [...weeks.keys()]
    .sort()
    .filter((w) => nextWeek(w) < weekOf(now))
    .map((week) => {
      const active = weeks.get(week)!;
      const after = weeks.get(nextWeek(week)) ?? new Set<string>();
      return { week, active: active.size, returned: [...active].filter((u) => after.has(u)).length };
    });
}

export function funnel(all: readonly FunnelQuest[], now: Date, days: number) {
  // The funnel follows quests offered in the window.
  const quests = all.filter((q) => now.getTime() - q.offeredAt.getTime() <= days * DAY_MS);
  const accepted = quests.filter((q) => q.acceptedAt || q.completedAt);
  const checkedIn = quests.filter((q) => q.completedAt);
  const worth = (a: string) => checkedIn.filter((q) => q.worthIt === a).length;
  return {
    people: new Set(quests.map((q) => q.userId)).size,
    offered: quests.length,
    accepted: accepted.length,
    checkedIn: checkedIn.length,
    peopleCheckedIn: new Set(checkedIn.map((q) => q.userId)).size,
    checkedInWithin7Days: checkedIn.filter((q) => q.acceptedAt && q.completedAt!.getTime() - q.acceptedAt.getTime() <= 7 * DAY_MS).length,
    worthIt: { yes: worth('yes'), meh: worth('meh'), no: worth('no') },
    wasOpenAnswered: checkedIn.filter((q) => q.wasOpen !== null).length,
    wastedWalks: checkedIn.filter((q) => q.wasOpen === false).length,
    weeklyReturn: weeklyReturn(all, now),
  };
}

const of = (n: number, d: number) => (d ? `${n} of ${d} (${Math.round((n / d) * 100)}%)` : `${n} of 0`);

export function render(f: ReturnType<typeof funnel>, days: number, excluded: number): string[] {
  const w = f.worthIt;
  return [
    `Funnel, quests offered in the last ${days} days (${excluded} account ids and simulated check-ins left out)`,
    `People offered a quest: ${f.people}. With about 15 people, read the counts, not the percentages.`,
    '',
    `  offered       ${f.offered}`,
    `  accepted      ${of(f.accepted, f.offered)}`,
    `  checked in    ${of(f.checkedIn, f.accepted)} by ${f.peopleCheckedIn} people`,
    `  worth it      yes ${w.yes}, meh ${w.meh}, no ${w.no}, unanswered ${f.checkedIn - w.yes - w.meh - w.no}`,
    '',
    `  accept -> check-in within 7 days   ${of(f.checkedInWithin7Days, f.accepted)}`,
    `  wasted walks (wasn't open / check-ins)   ${of(f.wastedWalks, f.checkedIn)}; answered: ${f.wasOpenAnswered}`,
    '',
    'Weekly return (accepted or checked in during the week, then again the next):',
    ...(f.weeklyReturn.length ? f.weeklyReturn.map((r) => `  week of ${r.week}: ${of(r.returned, r.active)}`) : ['  no complete pair of weeks yet']),
  ];
}

export async function loadFunnel(db: Pick<PoolClient, 'query'>, excluded: readonly string[]): Promise<FunnelQuest[]> {
  return (await db.query<FunnelQuest>(FUNNEL_SQL, [excluded])).rows;
}

export function excludedIds(env: NodeJS.ProcessEnv, extra: string | undefined): string[] {
  return [...new Set([...adminIds(env.ADMIN_USER_IDS), ...adminIds(env.DEMO_CLERK_USER_ID), ...adminIds(extra)])];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const days = Number(arg('--days') ?? 28);
  if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a positive integer');
  const excluded = excludedIds(process.env, arg('--exclude'));
  // Without these the owner's own testing would be the numbers.
  if (!adminIds(process.env.ADMIN_USER_IDS).size && !arg('--exclude')) {
    throw new Error("set ADMIN_USER_IDS or --exclude to the owner's user id");
  }
  if (!process.env.DEMO_CLERK_USER_ID?.trim()) console.warn('DEMO_CLERK_USER_ID is not set: the demo account is only left out if listed in --exclude');
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const quests = await loadFunnel(client, excluded);
    await client.query('ROLLBACK');
    console.log(render(funnel(quests, new Date(), days), days, excluded.length).join('\n'));
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
