import { fromBinary } from '@bufbuild/protobuf';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { createPool } from '../db/db.module';
import { assertDisposableDatabase } from '../db/test-guard';
import { QuestAction, QuestEventSchema, SkipReason } from '../gen/larper/events/v1/events_pb';
import type { TagsService } from '../profile/tags.service';
import type { AreasService } from './areas.service';
import { QuestsService } from './quests.service';
import { REOFFER_AFTER_DAYS, type ReofferKey } from './transitions';

// "Not today" and its optional reason against a real database: the column, the
// events in the outbox, and which ones move taste. Skipped unless TEST_DATABASE_URL is
// set; the same setup as checkin.db.spec.ts (the service as the API's role, fixtures
// and cleanup as the owner).
const URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? URL;
const describeDb = URL ? describe : describe.skip;

describeDb('Not today and skip reasons (real database)', () => {
  let pool: Pool;
  let owner: Pool;
  let quests: QuestsService;
  let userId: string;
  let placeId: string;
  let questId: string;

  beforeAll(async () => {
    pool = createPool(URL);
    owner = createPool(OWNER_URL);
    await assertDisposableDatabase(owner, 'skip-reason.db.spec');
    quests = new QuestsService(pool, {} as CacheService, {} as TagsService, {} as AreasService);
    const u = await owner.query<{ id: string }>(
      `INSERT INTO users (clerk_id) VALUES ('test_skipreason_' || gen_random_uuid()) RETURNING id::text`,
    );
    userId = u.rows[0].id;
    const p = await owner.query<{ id: string }>(
      `INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
       VALUES ('test-skipreason-' || gen_random_uuid(), 'Test Cafe',
               ST_SetSRID(ST_MakePoint(-73.9971, 40.7312), 4326)::geography, '{cafe}', 'test-cafe', '{cafe}',
               array_fill(0, ARRAY[160])::vector, 0.9)
       RETURNING id::text`,
    );
    placeId = p.rows[0].id;
  });

  afterAll(async () => {
    if (userId) {
      await owner.query('DELETE FROM outbox WHERE key = $1', [userId]);
      await owner.query('DELETE FROM users WHERE id = $1', [userId]); // cascades to quests
      await owner.query('DELETE FROM places WHERE id = $1', [placeId]);
    }
    await pool.end();
    await owner.end();
  });

  const newQuest = async (status: 'offered' | 'accepted') => {
    await owner.query('DELETE FROM quests WHERE user_id = $1', [userId]);
    await owner.query('DELETE FROM outbox WHERE key = $1', [userId]);
    const q = await owner.query<{ id: string }>(
      `INSERT INTO quests (user_id, place_id, status, score, reasons, origin)
       VALUES ($1, $2, $3, 1, '{}', ST_SetSRID(ST_MakePoint(-73.9971, 40.7312), 4326)::geography)
       RETURNING id::text`,
      [userId, placeId, status],
    );
    questId = q.rows[0].id;
  };
  const row = async () =>
    (
      await owner.query<{ status: string; reason: string | null }>(
        'SELECT status, skip_reason AS reason FROM quests WHERE id = $1',
        [questId],
      )
    ).rows[0];
  // The user's events, oldest first, decoded as taste-worker would.
  const events = async () =>
    (await owner.query<{ payload: Buffer }>('SELECT payload FROM outbox WHERE key = $1 ORDER BY id', [userId])).rows.map(
      (r) => fromBinary(QuestEventSchema, r.payload),
    );

  it('sets an accepted quest aside, neutral: no SKIPPED event, reason unstated', async () => {
    await newQuest('accepted');
    await expect(quests.act(userId, questId, 'not-today')).resolves.toEqual({ id: questId, status: 'skipped' });
    expect(await row()).toEqual({ status: 'skipped', reason: 'unstated' });
    const [evt, ...rest] = await events();
    expect(rest).toHaveLength(0);
    expect(evt).toMatchObject({ questId, placeId, action: QuestAction.NOT_TODAY, skipReason: SkipReason.UNSPECIFIED });
  });

  it('records a neutral reason on the quest and on its event, with no taste penalty', async () => {
    await newQuest('accepted');
    await quests.act(userId, questId, 'not-today');
    await expect(quests.giveReason(userId, questId, 'closed')).resolves.toEqual({
      id: questId,
      status: 'skipped',
      reason: 'closed',
    });
    expect(await row()).toEqual({ status: 'skipped', reason: 'closed' });
    const evts = await events();
    expect(evts.map((e) => [e.action, e.skipReason])).toEqual([
      [QuestAction.NOT_TODAY, SkipReason.UNSPECIFIED],
      [QuestAction.NOT_TODAY, SkipReason.CLOSED],
    ]);
    expect(evts.some((e) => e.action === QuestAction.SKIPPED)).toBe(false);
  });

  it('"Not my thing" is the skip penalty: a SKIPPED event, carrying the reason', async () => {
    await newQuest('accepted');
    await quests.act(userId, questId, 'not-today');
    await quests.giveReason(userId, questId, 'not_my_thing');
    expect(await row()).toEqual({ status: 'skipped', reason: 'not_my_thing' });
    expect((await events()).at(-1)).toMatchObject({ action: QuestAction.SKIPPED, skipReason: SkipReason.NOT_MY_THING });
  });

  it('takes one reason only', async () => {
    await newQuest('accepted');
    await quests.act(userId, questId, 'not-today');
    await quests.giveReason(userId, questId, 'too_far');
    await expect(quests.giveReason(userId, questId, 'not_my_thing')).rejects.toThrow(
      new ConflictException('this quest already has a reason'),
    );
    expect(await row()).toEqual({ status: 'skipped', reason: 'too_far' });
    expect(await events()).toHaveLength(2); // nothing written for the refused one
  });

  it('a plain Skip keeps its penalty and takes no reason', async () => {
    await newQuest('offered');
    await quests.act(userId, questId, 'skip');
    expect(await row()).toEqual({ status: 'skipped', reason: null });
    expect((await events()).map((e) => e.action)).toEqual([QuestAction.SKIPPED]);
    await expect(quests.giveReason(userId, questId, 'too_far')).rejects.toThrow(
      new ConflictException('only a quest set aside with Not today takes a reason'),
    );
  });

  it('refuses a reason for a quest that is still live, and Not today on an offer', async () => {
    await newQuest('accepted');
    await expect(quests.giveReason(userId, questId, 'closed')).rejects.toThrow(ConflictException);
    await newQuest('offered');
    await expect(quests.act(userId, questId, 'not-today')).rejects.toThrow('cannot set aside a quest that is offered');
    expect(await events()).toHaveLength(0);
  });

  it("refuses a reason for someone else's quest as not found", async () => {
    await newQuest('accepted');
    await quests.act(userId, questId, 'not-today');
    await expect(quests.giveReason('0', questId, 'closed')).rejects.toThrow(NotFoundException);
  });
});

// How long each kind of ending keeps its place out of the deck. The windows, as
// decided (PR #25): pinned here so a change to REOFFER_AFTER_DAYS is a test change too.
const WINDOWS: { key: ReofferKey; status: 'skipped' | 'completed'; reason: string | null; days: number }[] = [
  { key: 'unstated', status: 'skipped', reason: 'unstated', days: 1 },
  { key: 'not_today', status: 'skipped', reason: 'not_today', days: 1 },
  { key: 'closed', status: 'skipped', reason: 'closed', days: 3 },
  { key: 'too_far', status: 'skipped', reason: 'too_far', days: 7 },
  { key: 'not_my_thing', status: 'skipped', reason: 'not_my_thing', days: 30 },
  { key: 'skip', status: 'skipped', reason: null, days: 30 }, // a plain Skip: unchanged
  { key: 'completed', status: 'completed', reason: null, days: 30 }, // unchanged
];

describeDb('re-offering a place after a skip, by reason (real database)', () => {
  let pool: Pool;
  let owner: Pool;
  let quests: QuestsService;
  let userId: string;
  const placeIds: string[] = [];

  beforeAll(async () => {
    pool = createPool(URL);
    owner = createPool(OWNER_URL);
    await assertDisposableDatabase(owner, 'skip-reason.db.spec (re-offer)');
    quests = new QuestsService(pool, {} as CacheService, {} as TagsService, {} as AreasService);
    const u = await owner.query<{ id: string }>(
      `INSERT INTO users (clerk_id) VALUES ('test_reoffer_' || gen_random_uuid()) RETURNING id::text`,
    );
    userId = u.rows[0].id;
  });

  afterAll(async () => {
    if (userId) {
      await owner.query('DELETE FROM outbox WHERE key = $1', [userId]);
      await owner.query('DELETE FROM users WHERE id = $1', [userId]); // cascades to quests
      if (placeIds.length) await owner.query('DELETE FROM places WHERE id = ANY($1::bigint[])', [placeIds]);
    }
    await pool.end();
    await owner.end();
  });

  const newPlace = async () => {
    const p = await owner.query<{ id: string }>(
      `INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
       VALUES ('test-reoffer-' || gen_random_uuid(), 'Test Spot',
               ST_SetSRID(ST_MakePoint(-73.9971, 40.7312), 4326)::geography, '{cafe}', 'test-spot', '{cafe}',
               array_fill(0, ARRAY[160])::vector, 0.9)
       RETURNING id::text`,
    );
    placeIds.push(p.rows[0].id);
    return p.rows[0].id;
  };
  // A finished quest at a new place, ended this many hours ago.
  const ended = async (status: string, reason: string | null, hoursAgo: number) => {
    const place = await newPlace();
    await owner.query(
      `INSERT INTO quests (user_id, place_id, status, skip_reason, score, reasons, origin, created_at, updated_at)
       VALUES ($1, $2, $3::quest_status, $4::skip_reason, 1, '{}',
               ST_SetSRID(ST_MakePoint(-73.9971, 40.7312), 4326)::geography,
               now() - make_interval(hours => $5), now() - make_interval(hours => $5))`,
      [userId, place, status, reason, hoursAgo],
    );
    return place;
  };
  const excluded = (): Promise<Set<string>> =>
    (quests as unknown as { recentlyDone(u: string): Promise<Set<string>> }).recentlyDone(userId);

  it('uses the decided window for every way a quest can end', () => {
    expect(REOFFER_AFTER_DAYS).toEqual(Object.fromEntries(WINDOWS.map((w) => [w.key, w.days])));
  });

  it.each(WINDOWS)('$key: out for $days day(s), then offered again', async ({ status, reason, days }) => {
    const inside = await ended(status, reason, days * 24 - 1); // an hour before the window ends
    const after = await ended(status, reason, days * 24 + 1); // an hour after
    const out = await excluded();
    expect(out.has(inside)).toBe(true);
    expect(out.has(after)).toBe(false);
  });

  it('a plain Skip of an offer still keeps the place out for 30 days, through the real action', async () => {
    const place = await newPlace();
    const q = await owner.query<{ id: string }>(
      `INSERT INTO quests (user_id, place_id, status, score, reasons, origin)
       VALUES ($1, $2, 'offered', 1, '{}', ST_SetSRID(ST_MakePoint(-73.9971, 40.7312), 4326)::geography)
       RETURNING id::text`,
      [userId, place],
    );
    await quests.act(userId, q.rows[0].id, 'skip');
    const backdate = (days: number) =>
      owner.query(`UPDATE quests SET updated_at = now() - make_interval(days => $2) WHERE id = $1`, [q.rows[0].id, days]);
    await backdate(29);
    expect((await excluded()).has(place)).toBe(true);
    await backdate(31);
    expect((await excluded()).has(place)).toBe(false);
  });

  it(`"Not today" then "Closed": 3 days from the skip (the reason doesn't restart the clock)`, async () => {
    const place = await newPlace();
    const q = await owner.query<{ id: string }>(
      `INSERT INTO quests (user_id, place_id, status, score, reasons, origin)
       VALUES ($1, $2, 'accepted', 1, '{}', ST_SetSRID(ST_MakePoint(-73.9971, 40.7312), 4326)::geography)
       RETURNING id::text`,
      [userId, place],
    );
    const id = q.rows[0].id;
    await quests.act(userId, id, 'not-today');
    // Set aside 2.5 days ago, with no reason yet: past the 1-day window, so back already.
    await owner.query(`UPDATE quests SET updated_at = now() - make_interval(hours => 60) WHERE id = $1`, [id]);
    expect((await excluded()).has(place)).toBe(false);
    // Saying "Closed" now makes it a 3-day window from the same skip: out again, for half a day.
    await quests.giveReason(userId, id, 'closed');
    const { rows } = await owner.query<{ h: number }>(
      `SELECT extract(epoch FROM now() - updated_at) / 3600 AS h FROM quests WHERE id = $1`,
      [id],
    );
    expect(Number(rows[0].h)).toBeGreaterThan(59); // the reason left updated_at alone
    expect((await excluded()).has(place)).toBe(true);
    await owner.query(`UPDATE quests SET updated_at = now() - make_interval(hours => 73) WHERE id = $1`, [id]);
    expect((await excluded()).has(place)).toBe(false);
  });
});
