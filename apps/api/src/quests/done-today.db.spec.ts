import { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { createPool } from '../db/db.module';
import { assertDisposableDatabase } from '../db/test-guard';
import type { TagsService } from '../profile/tags.service';
import type { AreasService } from './areas.service';
import { QuestsService } from './quests.service';
import type { Scored } from './scoring';

// One quest a day: after a check-in, GET /quests/today stays on the completed quest (no
// leads, no new offer) until midnight in New York; the demo account gets a new offer as
// before. Ranking is stubbed to one fixed lead, so this tests the quest lifecycle, not
// the candidates query. Same rules as checkin.db.spec: skipped unless TEST_DATABASE_URL
// is set, refuses a live stack, brings and deletes its own rows.
const URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? URL;
const describeDb = URL ? describe : describe.skip;

const HERE = { lat: 40.7312, lng: -73.9971 };

describeDb('one quest a day (real database)', () => {
  let pool: Pool;
  let owner: Pool;
  let quests: QuestsService;
  let userId: string;
  let doneId: string; // the place checked in at
  let leadId: string; // the place ranking offers next
  let doneQuestId: string;

  const cache = { getOrSet: async (_k: string, _t: number, fn: () => Promise<unknown>) => ({ value: await fn(), hit: false }) };
  const areas = { survey: async () => ({ pending: [], failed: [], outside: [] }) };

  const place = async (name: string) =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
         VALUES ('test-done-today-' || gen_random_uuid(), $1,
                 ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, '{cafe}', 'test-done-' || gen_random_uuid(), '{cafe}',
                 array_fill(0, ARRAY[160])::vector, 0.9)
         RETURNING id::text`,
        [name, HERE.lng, HERE.lat],
      )
    ).rows[0].id;

  beforeAll(async () => {
    pool = createPool(URL);
    owner = createPool(OWNER_URL);
    await assertDisposableDatabase(owner, 'done-today.db.spec');
    quests = new QuestsService(pool, cache as unknown as CacheService, {} as TagsService, areas as unknown as AreasService);
    userId = (
      await owner.query<{ id: string }>(
        `INSERT INTO users (clerk_id) VALUES ('test_done_today_' || gen_random_uuid()) RETURNING id::text`,
      )
    ).rows[0].id;
    doneId = await place('Test Done Cafe');
    leadId = await place('Test Lead Cafe');
  });

  afterAll(async () => {
    if (userId) {
      await owner.query('DELETE FROM users WHERE id = $1', [userId]); // cascades to quests
      await owner.query('DELETE FROM places WHERE id = ANY($1::bigint[])', [[doneId, leadId]]);
    }
    await pool.end();
    await owner.end();
  });

  beforeEach(async () => {
    await owner.query('DELETE FROM quests WHERE user_id = $1', [userId]);
    doneQuestId = (
      await owner.query<{ id: string }>(
        `INSERT INTO quests (user_id, place_id, status, score, reasons, origin)
         VALUES ($1, $2, 'completed', 1, '{}', ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography)
         RETURNING id::text`,
        [userId, doneId, HERE.lng, HERE.lat],
      )
    ).rows[0].id;
    const lead: Scored = {
      id: leadId, name: 'Test Lead Cafe', lat: HERE.lat, lng: HERE.lng, category: 'cafe', tags: ['cafe'],
      taste: 0.5, chainLocations: 1, confidence: 0.9, distanceM: 0, website: null, instagram: null, phone: null,
      score: 1, parts: { fit: 1, rarity: 0, indie: 1, quality: 1, decay: 1 },
      reasons: { liked: [], rarest: null, indie: true },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(quests as any, 'rank').mockResolvedValue([lead]);
  });
  afterEach(() => jest.restoreAllMocks());

  const today = (demo = false) => quests.today(userId, HERE.lat, HERE.lng, 1500, demo);
  const active = async () =>
    (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM quests WHERE user_id = $1 AND status IN ('offered', 'accepted')`, [userId]))
      .rows[0].n;
  // Moves the check-in to `minutes` after (or before, if negative) today's midnight in New York.
  const checkedInAt = (minutes: number) =>
    owner.query(
      `UPDATE quests SET updated_at = (date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')
                                      + make_interval(mins => $2)
       WHERE id = $1`,
      [doneQuestId, minutes],
    );

  it('stays on the quest checked in today, with no leads and no new offer', async () => {
    const res = await today();
    expect(res.quest).toMatchObject({ id: doneQuestId, status: 'completed' });
    expect(res.deck).toEqual([]);
    expect(await active()).toBe(0);
  });

  it('counts a check-in just after midnight in New York as today', async () => {
    await checkedInAt(1);
    expect((await today()).quest).toMatchObject({ id: doneQuestId, status: 'completed' });
  });

  it('offers a new quest once the day has turned over', async () => {
    await checkedInAt(-1); // 23:59 yesterday, New York time
    const res = await today();
    expect(res.quest).toMatchObject({ status: 'offered', place: { id: leadId } });
    expect(await active()).toBe(1);
  });

  it('keeps offering on the demo account, which visitors share', async () => {
    const res = await today(true);
    expect(res.quest).toMatchObject({ status: 'offered', place: { id: leadId } });
  });

  it('prefers a quest still in progress over the finished one', async () => {
    const other = await owner.query<{ id: string }>(
      `INSERT INTO quests (user_id, place_id, status, score, reasons, origin)
       VALUES ($1, $2, 'accepted', 1, '{}', ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography)
       RETURNING id::text`,
      [userId, leadId, HERE.lng, HERE.lat],
    );
    expect((await today()).quest).toMatchObject({ id: other.rows[0].id, status: 'accepted' });
  });
});
