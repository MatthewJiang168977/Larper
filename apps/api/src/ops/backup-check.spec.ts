import { BackupState, judge } from './backup-check';

const NOW = new Date('2026-10-21T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const LIMITS = { walMaxAgeHours: 48, baseBackupMaxAgeDays: 8 };
const healthy: BackupState = {
  now: NOW,
  lastArchived: hoursAgo(0.5),
  lastFailed: null,
  failedWal: null,
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
    expect(judge({ ...healthy, lastArchived: null }, LIMITS).problems).toEqual(['no WAL segment has ever been archived']);
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
