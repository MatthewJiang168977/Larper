import { NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import type { TagsService } from '../profile/tags.service';
import { DataExportService } from './data-export';

// The export reads from one connection inside one read-only REPEATABLE READ transaction,
// and always ends it and gives the connection back. Mocked pool: no database.
function pool(rows: (sql: string) => unknown[] | Error) {
  const log: string[] = [];
  const client = {
    query: jest.fn(async (sql: string) => {
      log.push(sql.split('\n')[0].slice(0, 60));
      const r = rows(sql);
      if (r instanceof Error) throw r;
      return { rows: r };
    }),
    release: jest.fn(),
  };
  return { pg: { connect: async () => client, query: jest.fn() } as unknown as Pool, client, log };
}
const tags = { ready: async () => undefined, tagOf: () => undefined } as unknown as TagsService;
const account = { id: '1', clerk_id: 'user_x', created_at: new Date('2026-01-01T00:00:00Z') };

describe('DataExportService transaction', () => {
  it('runs every read on one client in a read-only repeatable-read transaction, then commits and releases', async () => {
    const { pg, client, log } = pool((sql) => (sql.includes('FROM users') ? [account] : []));
    const out = await new DataExportService(pg, tags).export('1');
    expect(out.account.clerkId).toBe('user_x');
    expect(log[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    expect(log.at(-1)).toBe('COMMIT');
    expect(log).toHaveLength(9); // BEGIN, seven reads, COMMIT
    expect((pg.query as jest.Mock)).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('a missing account is a 404, and the transaction is still ended and released', async () => {
    const { pg, client, log } = pool(() => []);
    await expect(new DataExportService(pg, tags).export('1')).rejects.toThrow(NotFoundException);
    expect(log.at(-1)).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('a failing read rolls back, releases, and rethrows', async () => {
    const { pg, client, log } = pool((sql) => (sql.includes('FROM quests') ? new Error('boom') : [account]));
    await expect(new DataExportService(pg, tags).export('1')).rejects.toThrow('boom');
    expect(log.at(-1)).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
