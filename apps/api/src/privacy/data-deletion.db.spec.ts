import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { createPool } from '../db/db.module';
import { assertDisposableDatabase } from '../db/test-guard';
import type { TagsService } from '../profile/tags.service';
import type { AreasService } from '../quests/areas.service';
import { QuestsService, SCRUB_ORIGINS_SQL } from '../quests/quests.service';
import { DataDeletionService } from './data-deletion';
import { DataExportService } from './data-export';

// Export and delete my data (migration 0020) against a real database, as the API's role
// (TEST_DATABASE_URL: it has no DELETE grant, so every delete here goes through the
// SECURITY DEFINER functions); fixtures and checks as the owner. Skipped without it.
const URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? URL;
const describeDb = URL ? describe : describe.skip;

const HERE = { lat: 40.7312, lng: -73.9971 };

describeDb('export and delete my data (real database)', () => {
  let pool: Pool;
  let owner: Pool;
  let deletion: DataDeletionService;
  let exporter: DataExportService;
  let quests: QuestsService;
  const forgot: string[] = [];
  const placeIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    pool = createPool(URL);
    owner = createPool(OWNER_URL);
    await assertDisposableDatabase(owner, 'data-deletion.db.spec');
    const cache = { forgetUser: async (id: string) => void forgot.push(id) } as unknown as CacheService;
    const tags = { ready: async () => undefined, tagOf: (slot: number) => (slot === 0 ? 'cafe' : undefined) } as unknown as TagsService;
    deletion = new DataDeletionService(pool, cache, null);
    exporter = new DataExportService(pool, tags);
    quests = new QuestsService(pool, cache, tags, {} as AreasService);
  });

  afterAll(async () => {
    for (const id of userIds) {
      await owner.query('DELETE FROM outbox WHERE key = $1', [id]);
      await owner.query('DELETE FROM users WHERE id = $1', [id]);
    }
    if (placeIds.length) await owner.query('DELETE FROM places WHERE id = ANY($1::bigint[])', [placeIds]);
    await pool.end();
    await owner.end();
  });

  const user = async () => {
    const { rows } = await owner.query<{ id: string; clerk_id: string }>(
      `INSERT INTO users (clerk_id) VALUES ('test_del_' || gen_random_uuid()) RETURNING id::text, clerk_id`,
    );
    userIds.push(rows[0].id);
    return { id: rows[0].id, clerkId: rows[0].clerk_id };
  };
  const place = async (name: string) => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
       VALUES ('test-del-' || gen_random_uuid(), $1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
               '{food_and_drink,cafe}', 'test-del-' || gen_random_uuid(), '{cafe}', array_fill(0, ARRAY[160])::vector, 0.9)
       RETURNING id::text`,
      [name, HERE.lng, HERE.lat],
    );
    placeIds.push(rows[0].id);
    return rows[0].id;
  };
  const quest = async (userId: string, placeId: string, status: string) =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO quests (user_id, place_id, status, score, reasons, origin, accepted_at, completed_at)
         VALUES ($1, $2, $3::quest_status, 1, '{"simulated": false}', ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
                 CASE WHEN $3 IN ('accepted', 'completed') THEN now() END, CASE WHEN $3 = 'completed' THEN now() END)
         RETURNING id::text`,
        [userId, placeId, status, HERE.lng, HERE.lat],
      )
    ).rows[0].id;
  const count = async (sql: string, ...params: unknown[]) =>
    Number((await owner.query<{ n: string }>(sql, params)).rows[0].n);

  // One person's whole footprint: a taste profile, a completed quest with a check-in
  // attempt and a "was it open?" answer, a saved place, and outbox events.
  const populate = async (u: { id: string }, tag: string) => {
    const p = await place(`${tag} Cafe`);
    const q = await quest(u.id, p, 'completed');
    await owner.query('INSERT INTO checkin_attempts (quest_id, outcome, distance_m, accuracy_m, allowed_m, demo) VALUES ($1, $2, 12, 8, 60, false)', [q, 'accepted']);
    await owner.query(
      `INSERT INTO place_hours_facts (place_id, kind, source, fetched_at, confidence, was_open, quest_id, user_id)
       VALUES ($1, 'observation', 'check-in', now(), 0.9, true, $2, $3)`,
      [p, q, u.id],
    );
    await owner.query('INSERT INTO saved_places (user_id, place_id, quest_id) VALUES ($1, $2, $3)', [u.id, p, q]);
    await owner.query(`INSERT INTO taste_profiles (user_id, vec, source) VALUES ($1, array_fill(0.1::real, ARRAY[160])::vector, 'onboarding')`, [u.id]);
    for (let i = 0; i < 2; i++) {
      await owner.query(`INSERT INTO outbox (topic, key, type, payload) VALUES ('user.events', $1, 'larper.events.v1.QuestEvent', '\\x00')`, [u.id]);
    }
    return { place: p, quest: q };
  };
  const footprint = async (id: string) => ({
    quests: await count('SELECT count(*) n FROM quests WHERE user_id = $1', id),
    attempts: await count('SELECT count(*) n FROM checkin_attempts a JOIN quests q ON q.id = a.quest_id WHERE q.user_id = $1', id),
    answers: await count('SELECT count(*) n FROM place_hours_facts WHERE user_id = $1', id),
    saved: await count('SELECT count(*) n FROM saved_places WHERE user_id = $1', id),
    taste: await count('SELECT count(*) n FROM taste_profiles WHERE user_id = $1', id),
    events: await count('SELECT count(*) n FROM outbox WHERE key = $1', id),
    account: await count('SELECT count(*) n FROM users WHERE id = $1', id),
  });
  const FULL = { quests: 1, attempts: 1, answers: 1, saved: 1, taste: 1, events: 2, account: 1 };

  it('delete history removes the journal, check-ins, answers, saved places and events; keeps the account and taste; leaves others alone', async () => {
    const a = await user();
    const b = await user();
    await populate(a, 'HistA');
    await populate(b, 'HistB');
    expect(await footprint(a.id)).toEqual(FULL);

    const out = await deletion.deleteHistory(a);
    expect(out).toEqual({ deleted: { quests: 1, checkInAttempts: 1, hoursAnswers: 1, savedPlaces: 1, events: 2 } });
    expect(await footprint(a.id)).toEqual({ quests: 0, attempts: 0, answers: 0, saved: 0, taste: 1, events: 0, account: 1 });
    expect(await footprint(b.id)).toEqual(FULL);
    expect(forgot).toContain(a.id);

    // Nothing left to delete: zeros, no error.
    await expect(deletion.deleteHistory(a)).resolves.toEqual({
      deleted: { quests: 0, checkInAttempts: 0, hoursAnswers: 0, savedPlaces: 0, events: 0 },
    });
  });

  it('delete account removes everything including the users row and taste; leaves others alone; repeating is harmless', async () => {
    const a = await user();
    const b = await user();
    await populate(a, 'AcctA');
    await populate(b, 'AcctB');

    const out = await deletion.deleteAccount(a);
    expect(out).toEqual({
      deleted: { quests: 1, checkInAttempts: 1, hoursAnswers: 1, savedPlaces: 1, events: 2, tasteProfile: true, account: true },
      clerkUser: 'manual',
    });
    expect(await footprint(a.id)).toEqual({ quests: 0, attempts: 0, answers: 0, saved: 0, taste: 0, events: 0, account: 0 });
    expect(await footprint(b.id)).toEqual(FULL);

    const again = await deletion.deleteAccount(a);
    expect(again.deleted).toMatchObject({ quests: 0, tasteProfile: false, account: false });
  });

  it('the API role still cannot delete anything itself, only through the functions', async () => {
    const a = await user();
    await expect(pool.query('DELETE FROM users WHERE id = $1', [a.id])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('DELETE FROM quests WHERE user_id = $1', [a.id])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT * FROM checkin_attempts')).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses the shared demo account (403, demo_account) and deletes nothing', async () => {
    const d = await user();
    await populate(d, 'Demo');
    const before = process.env.DEMO_CLERK_USER_ID;
    process.env.DEMO_CLERK_USER_ID = d.clerkId;
    try {
      for (const call of [() => deletion.deleteHistory(d), () => deletion.deleteAccount(d)]) {
        const err = await call().then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toMatchObject({ statusCode: 403, code: 'demo_account' });
      }
    } finally {
      if (before === undefined) delete process.env.DEMO_CLERK_USER_ID;
      else process.env.DEMO_CLERK_USER_ID = before;
    }
    expect(await footprint(d.id)).toEqual(FULL);
  });

  it("export holds the caller's own data and nothing of anyone else's", async () => {
    const a = await user();
    const b = await user();
    const pa = await populate(a, 'ExpA');
    await populate(b, 'ExpB');
    const out = await exporter.export(a.id, new Date('2026-11-17T12:00:00Z'));

    expect(out).toMatchObject({ version: 1, exportedAt: '2026-11-17T12:00:00.000Z', account: { id: a.id, clerkId: a.clerkId } });
    expect(out.onboarding).toEqual({ stored: false, note: expect.stringContaining('only seeded the taste profile') });
    expect(out.taste).toMatchObject({ source: 'onboarding', topTags: ['cafe'] });
    expect(out.taste?.weights).toEqual({ cafe: expect.closeTo(0.1, 5) });
    expect(out.journal).toHaveLength(1);
    expect(out.journal[0]).toMatchObject({ id: pa.quest, status: 'completed', place: { id: pa.place, name: 'ExpA Cafe', category: 'cafe' } });
    // A completed quest's exact position is dropped when it resolves, but a fixture row inserted directly keeps it.
    expect(out.journal[0].offeredFrom).toEqual({ lat: expect.closeTo(HERE.lat, 4), lng: expect.closeTo(HERE.lng, 4) });
    expect(out.checkIns.completed.map((c) => c.questId)).toEqual([pa.quest]);
    expect(out.checkIns.attempts).toEqual([
      expect.objectContaining({ questId: pa.quest, outcome: 'accepted', distanceM: 12, accuracyM: 8, allowedM: 60, demo: false }),
    ]);
    expect(out.hoursAnswers).toEqual([expect.objectContaining({ questId: pa.quest, wasOpen: true })]);
    expect(out.savedPlaces).toEqual([expect.objectContaining({ questId: pa.quest, place: expect.objectContaining({ id: pa.place }) })]);

    const text = JSON.stringify(out);
    expect(text).not.toContain(b.clerkId);
    expect(text).not.toContain('ExpB');
    // Nothing internal: no outbox, jobs or processed-event fields.
    expect(Object.keys(out).sort()).toEqual(['account', 'checkIns', 'exportedAt', 'hoursAnswers', 'journal', 'onboarding', 'savedPlaces', 'taste', 'version']);
  });

  it('export of an account that no longer exists is a 404, not a TypeError', async () => {
    const a = await user();
    await deletion.deleteAccount(a);
    await expect(exporter.export(a.id)).rejects.toThrow(NotFoundException);
  });

  it('export of a user with no data is empty lists and a null taste, not an error', async () => {
    const a = await user();
    const out = await exporter.export(a.id);
    expect(out).toMatchObject({ taste: null, journal: [], checkIns: { completed: [], attempts: [] }, hoursAnswers: [], savedPlaces: [] });
  });

  describe('the exact offer position (quests.origin)', () => {
    const origin = async (id: string) =>
      (await owner.query<{ has: boolean }>('SELECT origin IS NOT NULL AS has FROM quests WHERE id = $1', [id])).rows[0].has;

    it('is dropped when an offer is skipped, and kept while it is open or accepted', async () => {
      const u = await user();
      const open = await quest(u.id, await place('Origin A'), 'offered');
      await quests.act(u.id, open, 'accept');
      expect(await origin(open)).toBe(true); // accepted: still live
      await quests.act(u.id, open, 'skip');
      expect(await origin(open)).toBe(false);
    });

    it('the sweep drops it for expired, completed and skipped quests only, as the API role', async () => {
      const u = await user();
      const ids: Record<string, string> = {};
      for (const s of ['expired', 'completed', 'skipped']) ids[s] = await quest(u.id, await place(`Sweep ${s}`), s);
      ids.offered = await quest(u.id, await place('Sweep offered'), 'offered');
      await pool.query(SCRUB_ORIGINS_SQL);
      expect(await origin(ids.expired)).toBe(false);
      expect(await origin(ids.completed)).toBe(false);
      expect(await origin(ids.skipped)).toBe(false);
      expect(await origin(ids.offered)).toBe(true);
    });
  });
});
