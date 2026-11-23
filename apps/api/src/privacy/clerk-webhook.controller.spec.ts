import { createHmac } from 'node:crypto';
import { Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { ClerkWebhookController } from './clerk-webhook.controller';
import type { PendingClerkDeletions } from './pending-clerk-deletions';

// The controller with a fake pool, cache and pending list: nothing leaves this file.
const KEY = Buffer.from('larper-test-webhook-key-0123', 'utf8');
const ID = 'user_abc123';

function signed(event: unknown, at = Date.now()) {
  const body = Buffer.from(JSON.stringify(event));
  const ts = String(Math.floor(at / 1000));
  const sig = createHmac('sha256', KEY).update(`msg_1.${ts}.`).update(body).digest('base64');
  return { req: { rawBody: body } as never, id: 'msg_1', ts, sig: `v1,${sig}` };
}

function controller(opts: { secret?: Buffer | null; rows?: string[] } = {}) {
  const query = jest.fn<Promise<{ rows: unknown[] }>, [string, unknown[]?]>(async (sql: string) => {
    if (sql.startsWith('SELECT id::text AS id FROM users')) return { rows: (opts.rows ?? []).map((id) => ({ id })) };
    return { rows: [{}] };
  });
  const forgetUser = jest.fn(async () => undefined);
  const done = jest.fn(async () => undefined);
  const c = new ClerkWebhookController(
    opts.secret === undefined ? KEY : opts.secret,
    { query } as unknown as Pool,
    { forgetUser } as unknown as CacheService,
    { done } as unknown as PendingClerkDeletions,
  );
  const call = (s: ReturnType<typeof signed>) => c.clerk(s.req, s.id, s.ts, s.sig);
  return { call, query, forgetUser, done };
}

describe('POST /webhooks/clerk', () => {
  let logs: jest.SpyInstance[];
  beforeEach(() => {
    logs = (['log', 'warn', 'error'] as const).map((m) => jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.DEMO_CLERK_USER_ID;
  });
  const logText = () => JSON.stringify(logs.flatMap((l) => l.mock.calls));

  it('is a 404 while CLERK_WEBHOOK_SIGNING_SECRET is unset', async () => {
    const { call, query } = controller({ secret: null });
    await expect(call(signed({ type: 'user.deleted', data: { id: ID } }))).rejects.toBeInstanceOf(NotFoundException);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a bad signature with 401 and touches nothing', async () => {
    const { call, query, done } = controller();
    const s = signed({ type: 'user.deleted', data: { id: ID } });
    await expect(call({ ...s, sig: 'v1,AAAA' })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(call({ ...s, req: { rawBody: undefined } as never })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(query).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it('user.deleted: deletes the Larper account for that Clerk id, drops its decks and clears any owed deletion', async () => {
    const { call, query, forgetUser, done } = controller({ rows: ['7'] });
    await expect(call(signed({ type: 'user.deleted', data: { id: ID, deleted: true } }))).resolves.toEqual({ ok: true });
    expect(query.mock.calls.map((c) => c[1])).toEqual([[ID], ['7']]);
    expect(query.mock.calls[1][0]).toMatch(/^SELECT delete_my_account/);
    expect(forgetUser.mock.calls).toEqual([['7']]);
    expect(done.mock.calls).toEqual([[ID]]);
    expect(logText()).not.toMatch(/user_abc123|\b7\b/);
  });

  it('user.deleted for a Clerk user Larper never saw (or already deleted) is a 200 that changes nothing', async () => {
    const { call, query, done } = controller({ rows: [] });
    await expect(call(signed({ type: 'user.deleted', data: { id: ID } }))).resolves.toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(done.mock.calls).toEqual([[ID]]);
  });

  it('ignores the shared demo account: its data belongs to the nightly reset', async () => {
    process.env.DEMO_CLERK_USER_ID = ID;
    const { call, query, done } = controller({ rows: ['7'] });
    await expect(call(signed({ type: 'user.deleted', data: { id: ID } }))).resolves.toEqual({ ok: true });
    expect(query).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it('other event types and malformed ids are a 200 that changes nothing', async () => {
    const { call, query } = controller({ rows: ['7'] });
    await call(signed({ type: 'user.created', data: { id: ID } }));
    await call(signed({ type: 'user.deleted', data: { id: '../users/x' } }));
    await call(signed({ type: 'user.deleted', data: {} }));
    expect(query).not.toHaveBeenCalled();
  });

  it('a database failure is a 500, so Clerk retries the webhook', async () => {
    const { call, query } = controller({ rows: ['7'] });
    query.mockRejectedValueOnce(new Error('db down'));
    await expect(call(signed({ type: 'user.deleted', data: { id: ID } }))).rejects.toThrow('db down');
  });
});
