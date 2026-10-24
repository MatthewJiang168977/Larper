import { BackupState, judge } from './backup-check';

const NOW = new Date('2026-10-21T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const LIMITS = { walMaxAgeHours: 48, baseBackupMaxAgeDays: 8, resetGraceHours: 3 };
const healthy: BackupState = {
  now: NOW,
  lastArchived: hoursAgo(0.5),
  lastFailed: null,
  failedWal: null,
  statsReset: hoursAgo(72),
  lastBaseBackup: hoursAgo(6 * 24), // weekly: up to 7 days old is normal
};

describe('judge: are the backups fresh?', () => {
  it('passes a healthy cluster, and says how fresh', () => {
    expect(judge(healthy, LIMITS)).toEqual({
      ok: true,
      problems: [],
      summary: 'last WAL archived 0.5 h ago; last base backup 6.0 days ago',
    });
  });

  it('passes a WAL age just under the limit, fails one over it', () => {
    expect(judge({ ...healthy, lastArchived: hoursAgo(47.9) }, LIMITS).ok).toBe(true);
    expect(judge({ ...healthy, lastArchived: hoursAgo(49) }, LIMITS)).toMatchObject({
      ok: false,
      problems: ['last WAL archived 2.0 days ago (limit 48 h)'],
    });
  });

  it('fails when nothing was ever archived', () => {
    expect(judge({ ...healthy, lastArchived: null, statsReset: null }, LIMITS).problems).toEqual([
      'no WAL segment has ever been archived',
    ]);
  });

  it('notes a failing archiver without alerting while the recovery point is still fresh', () => {
    const v = judge({ ...healthy, lastFailed: hoursAgo(0.1), failedWal: '000000010000000000000009' }, LIMITS);
    expect(v.ok).toBe(true); // Postgres retries every minute; a blip clears on its own
    expect(v.summary).toContain('archiving is failing (last failure 0.1 h ago, 000000010000000000000009)');
  });

  it('says why when the archiver has been failing long enough to go stale', () => {
    const v = judge({ ...healthy, lastArchived: hoursAgo(50), lastFailed: hoursAgo(0.1), failedWal: null }, LIMITS);
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual(['last WAL archived 2.1 days ago (limit 48 h)', 'archiving is failing (last failure 0.1 h ago)']);
  });

  it('ignores a failure that a later success has superseded', () => {
    expect(judge({ ...healthy, lastFailed: hoursAgo(3) }, LIMITS).summary).not.toContain('failing');
  });

  it('allows the weekly base backup plus a day, not more', () => {
    expect(judge({ ...healthy, lastBaseBackup: hoursAgo(7.9 * 24) }, LIMITS).ok).toBe(true);
    expect(judge({ ...healthy, lastBaseBackup: hoursAgo(8.5 * 24) }, LIMITS).problems).toEqual([
      'last base backup 8.5 days ago (limit 8 days)',
    ]);
    expect(judge({ ...healthy, lastBaseBackup: null }, LIMITS).problems).toEqual(['no completed base backup']);
  });

  it('reports every problem at once', () => {
    expect(judge({ ...healthy, lastArchived: null, lastBaseBackup: null }, LIMITS).problems).toHaveLength(2);
  });
});

describe('judge: right after the archiver counters reset (an unclean restart)', () => {
  // A reboot reset pg_stat_archiver: last_archived_time is NULL until the next segment
  // ships. The check at 22:17 on 2026-10-24 failed this way, 51 min after the reset.
  const reset = (h: number, over: Partial<BackupState> = {}): BackupState => ({
    ...healthy,
    lastArchived: null,
    lastFailed: null,
    statsReset: hoursAgo(h),
    ...over,
  });

  it('only notes "nothing archived yet" during the grace period (the 2026-10-24 false alarm)', () => {
    const v = judge(reset(0.85), LIMITS);
    expect(v.ok).toBe(true);
    expect(v.summary).toContain('archiver counters reset 0.8 h ago, nothing archived since yet (grace 3 h)');
  });

  it('still fails at once if Postgres reports an archive failure during the grace period', () => {
    const v = judge(reset(0.5, { lastFailed: hoursAgo(0.2), failedWal: '000000010000000000000068' }), LIMITS);
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual([
      'archiving failed since the counters reset 0.5 h ago (last failure 0.2 h ago, 000000010000000000000068)',
    ]);
  });

  it('fails once the grace period is over and still nothing has been archived', () => {
    const v = judge(reset(3.5), LIMITS);
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual(["no WAL segment archived since the archiver's counters reset 3.5 h ago (grace 3 h)"]);
  });

  it('is back to the usual rules as soon as a segment ships after the reset', () => {
    const v = judge(reset(1, { lastArchived: hoursAgo(0.2) }), LIMITS);
    expect(v).toMatchObject({ ok: true, problems: [] });
    expect(v.summary).toContain('last WAL archived 0.2 h ago');
    expect(v.summary).not.toContain('reset');
  });

  it("doesn't excuse a stale base backup during the grace period", () => {
    expect(judge(reset(0.5, { lastBaseBackup: hoursAgo(9 * 24) }), LIMITS).problems).toEqual([
      'last base backup 9.0 days ago (limit 8 days)',
    ]);
  });
});
