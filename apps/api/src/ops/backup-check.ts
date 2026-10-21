import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

// Are the Postgres backups fresh enough to restore from? Run hourly by the chart's
// backup-check CronJob (postgres.backup.check), which reports to a dead-man's switch
// (healthchecks.io): a ping when fresh, /fail with the reasons when stale, and nothing
// at all if the job stops running, which the service turns into an alert too.
//
// Two ages, against limits:
// - WAL: when the last segment reached the object store (pg_stat_archiver). This is
//   the recovery point: writes after it would be lost.
// - Base backup: when the last one completed (the Barman Cloud plugin's ObjectStore
//   status). WAL only restores on top of a base backup, and the bucket's lifecycle rule
//   deletes objects after 60 days.
//
// An idle database writes no WAL, so Postgres has nothing to archive and archive_timeout
// never fires: a healthy but idle cluster would look stale after 48 h. So every run
// first commits a transaction that writes WAL (heartbeat). archive_timeout (1 h) then
// ships it within the hour, and on a healthy cluster the WAL age stays under ~2 h
// however quiet the app is. If the heartbeat itself fails, that's reported.

export interface BackupState {
  now: Date;
  lastArchived: Date | null; // pg_stat_archiver.last_archived_time
  lastFailed: Date | null; // pg_stat_archiver.last_failed_time
  failedWal: string | null; // pg_stat_archiver.last_failed_wal
  lastBaseBackup: Date | null; // ObjectStore status: lastSuccessfulBackupTime
}

export interface Limits {
  walMaxAgeHours: number;
  baseBackupMaxAgeDays: number;
}

export interface Verdict {
  ok: boolean;
  problems: string[];
  summary: string;
}

const HOUR = 3_600_000;
const age = (now: Date, then: Date) => (now.getTime() - then.getTime()) / HOUR;
const fmt = (hours: number) => (hours < 48 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} days`);

export function judge(s: BackupState, limits: Limits): Verdict {
  const problems: string[] = [];
  const parts: string[] = [];

  if (!s.lastArchived) {
    problems.push('no WAL segment has ever been archived');
  } else {
    const h = age(s.now, s.lastArchived);
    parts.push(`last WAL archived ${fmt(h)} ago`);
    if (h > limits.walMaxAgeHours) problems.push(`last WAL archived ${fmt(h)} ago (limit ${limits.walMaxAgeHours} h)`);
  }
  // Failing right now: the last attempt failed after the last success. Not a problem on
  // its own (Postgres retries every minute and a blip clears), but it says why.
  if (s.lastFailed && (!s.lastArchived || s.lastFailed > s.lastArchived)) {
    const note = `archiving is failing (last failure ${fmt(age(s.now, s.lastFailed))} ago${s.failedWal ? `, ${s.failedWal}` : ''})`;
    parts.push(note);
    if (problems.length) problems.push(note);
  }

  if (!s.lastBaseBackup) {
    problems.push('no completed base backup');
  } else {
    const h = age(s.now, s.lastBaseBackup);
    parts.push(`last base backup ${fmt(h)} ago`);
    if (h > limits.baseBackupMaxAgeDays * 24) {
      problems.push(`last base backup ${fmt(h)} ago (limit ${limits.baseBackupMaxAgeDays} days)`);
    }
  }

  return { ok: problems.length === 0, problems, summary: parts.join('; ') };
}

// --- the CronJob's entry point -------------------------------------------------------

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

async function readState(pool: Pool): Promise<{ state: BackupState; heartbeatError?: string }> {
  let heartbeatError: string | undefined;
  try {
    // Assigning a transaction id makes its commit a WAL record: something to archive.
    await pool.query('SELECT pg_current_xact_id()');
  } catch (e) {
    heartbeatError = `heartbeat failed: ${(e as Error).message}`;
  }
  const { rows } = await pool.query<{ now: Date; archived: Date | null; failed: Date | null; failedWal: string | null }>(
    `SELECT now() AS now, last_archived_time AS archived, last_failed_time AS failed, last_failed_wal AS "failedWal"
     FROM pg_stat_archiver`,
  );
  const ns = readFileSync(`${SA}/namespace`, 'utf8').trim();
  const token = readFileSync(`${SA}/token`, 'utf8').trim();
  const store = process.env.OBJECT_STORE ?? 'pg-backups';
  const server = process.env.SERVER_NAME ?? 'pg';
  // NODE_EXTRA_CA_CERTS (set by the CronJob) makes fetch trust the cluster's CA.
  const res = await fetch(
    `https://kubernetes.default.svc/apis/barmancloud.cnpg.io/v1/namespaces/${ns}/objectstores/${store}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`reading ObjectStore ${store}: HTTP ${res.status}`);
  const status = ((await res.json()) as { status?: { serverRecoveryWindow?: Record<string, { lastSuccessfulBackupTime?: string }> } })
    .status;
  const last = status?.serverRecoveryWindow?.[server]?.lastSuccessfulBackupTime;
  const r = rows[0];
  return {
    state: {
      now: r.now,
      lastArchived: r.archived,
      lastFailed: r.failed,
      failedWal: r.failedWal,
      lastBaseBackup: last ? new Date(last) : null,
    },
    heartbeatError,
  };
}

async function report(url: string | undefined, ok: boolean, body: string) {
  if (!url) return;
  // healthchecks.io: the URL itself is "success", URL/fail is "failure"; the body is shown.
  const res = await fetch(ok ? url : `${url.replace(/\/$/, '')}/fail`, { method: 'POST', body });
  if (!res.ok) console.error(`ping failed: HTTP ${res.status}`);
}

async function main() {
  const limits: Limits = {
    walMaxAgeHours: Number(process.env.WAL_MAX_AGE_HOURS ?? 48),
    baseBackupMaxAgeDays: Number(process.env.BASE_BACKUP_MAX_AGE_DAYS ?? 8),
  };
  const ping = process.env.PING_URL || undefined;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10_000 });
  let verdict: Verdict;
  try {
    const { state, heartbeatError } = await readState(pool);
    verdict = judge(state, limits);
    if (heartbeatError) verdict = { ...verdict, ok: false, problems: [...verdict.problems, heartbeatError] };
  } catch (e) {
    verdict = { ok: false, problems: [`check failed: ${(e as Error).message}`], summary: '' };
  } finally {
    await pool.end().catch(() => undefined);
  }
  const line = verdict.ok ? `backups fresh: ${verdict.summary}` : `BACKUPS STALE: ${verdict.problems.join('; ')}`;
  console.log(`backup-check ${JSON.stringify({ ok: verdict.ok, problems: verdict.problems, summary: verdict.summary })}`);
  await report(ping, verdict.ok, line).catch((e: Error) => console.error(`ping failed: ${e.message}`));
  process.exitCode = verdict.ok ? 0 : 1;
}

if (require.main === module) void main();
