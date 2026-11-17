import { ConflictException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { createPool } from '../db/db.module';
import { assertDisposableDatabase } from '../db/test-guard';
import type { TagsService } from '../profile/tags.service';
import type { AreasService } from './areas.service';
import { QuestsService } from './quests.service';

// Accepting a quest saves its place to the "want to go" list (migration 0017), in the
// same transaction, and GET /saved-places reads it back. Skipped unless TEST_DATABASE_URL
// is set; the service runs as the API's role (which can insert and read saved places,
// not update or delete), fixtures and cleanup as the owner.
const URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? URL;
const describeDb = URL ? describe : describe.skip;

const HERE = { lat: 40.7312, lng: -73.9971 };

describeDb('saved places (real database)', () => {
  let pool: Pool;
  let owner: Pool;
  let quests: QuestsService;
  const placeIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    pool = createPool(URL);
    owner = createPool(OWNER_URL);
    await assertDisposableDatabase(owner, 'saved-places.db.spec');
    quests = new QuestsService(pool, {} as CacheService, {} as TagsService, {} as AreasService);
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
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO users (clerk_id) VALUES ('test_saved_' || gen_random_uuid()) RETURNING id::text`,
    );
    userIds.push(rows[0].id);
    return rows[0].id;
  };
  const place = async (name = 'Saved Spot') => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
       VALUES ('test-saved-' || gen_random_uuid(), $1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
               '{food_and_drink,cafe}', 'test-saved-' || gen_random_uuid(), '{cafe}', array_fill(0, ARRAY[160])::vector, 0.9)
       RETURNING id::text`,
      [name, HERE.lng, HERE.lat],
    );
    placeIds.push(rows[0].id);
    return rows[0].id;
  };
  const quest = async (userId: string, placeId: string, status: string) =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO quests (user_id, place_id, status, score, reasons, origin)
         VALUES ($1, $2, $3::quest_status, 1, '{}', ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography)
         RETURNING id::text`,
        [userId, placeId, status, HERE.lng, HERE.lat],
      )
    ).rows[0].id;
  const saved = async (userId: string) =>
    (
      await owner.query<{ place_id: string; quest_id: string | null }>(
        'SELECT place_id::text, quest_id::text FROM saved_places WHERE user_id = $1 ORDER BY created_at, place_id',
        [userId],
      )
    ).rows;

  it('accepting saves the place, with the quest that saved it', async () => {
    const u = await user();
    const p = await place();
    const q = await quest(u, p, 'offered');
    await expect(quests.act(u, q, 'accept')).resolves.toEqual({ id: q, status: 'accepted' });
    expect(await saved(u)).toEqual([{ place_id: p, quest_id: q }]);
  });

  it('accepting a second quest at the same place later keeps one row, and no error', async () => {
    const u = await user();
    const p = await place();
    const first = await quest(u, p, 'offered');
    await quests.act(u, first, 'accept');
    await quests.act(u, first, 'skip'); // frees the live-quest slot
    const second = await quest(u, p, 'offered');
    await expect(quests.act(u, second, 'accept')).resolves.toEqual({ id: second, status: 'accepted' });
    expect(await saved(u)).toEqual([{ place_id: p, quest_id: first }]);
  });

  it('a place already on the list does not stop an accept', async () => {
    const u = await user();
    const p = await place();
    await owner.query('INSERT INTO saved_places (user_id, place_id) VALUES ($1, $2)', [u, p]);
    const q = await quest(u, p, 'offered');
    await expect(quests.act(u, q, 'accept')).resolves.toEqual({ id: q, status: 'accepted' });
    expect(await saved(u)).toEqual([{ place_id: p, quest_id: null }]);
  });

  it('a conflicting accept (wrong state) answers 409 and saves nothing', async () => {
    const u = await user();
    await expect(quests.act(u, await quest(u, await place(), 'skipped'), 'accept')).rejects.toThrow(ConflictException);
    await expect(quests.act(u, await quest(u, await place(), 'completed'), 'accept')).rejects.toThrow(ConflictException);
    await expect(quests.act(u, await quest(u, await place(), 'accepted'), 'accept')).rejects.toThrow(ConflictException);
    expect(await saved(u)).toEqual([]);
  });

  it("accepting someone else's quest answers 404 and saves nothing for either of them", async () => {
    const a = await user();
    const b = await user();
    const q = await quest(a, await place(), 'offered');
    await expect(quests.act(b, q, 'accept')).rejects.toThrow(NotFoundException);
    await expect(quests.act(b, '0', 'accept')).rejects.toThrow(NotFoundException);
    expect(await saved(a)).toEqual([]);
    expect(await saved(b)).toEqual([]);
    expect((await owner.query('SELECT status FROM quests WHERE id = $1', [q])).rows[0].status).toBe('offered');
  });

  it('skip, not-today and complete save nothing', async () => {
    const u = await user();
    await quests.act(u, await quest(u, await place(), 'offered'), 'skip');
    await quests.act(u, await quest(u, await place(), 'accepted'), 'not-today');
    const done = await quest(u, await place(), 'accepted');
    await quests.act(u, done, 'complete', { lat: HERE.lat, lng: HERE.lng, accuracyM: 5 });
    expect((await owner.query('SELECT status FROM quests WHERE id = $1', [done])).rows[0].status).toBe('completed');
    expect(await saved(u)).toEqual([]);
  });

  describe('listing', () => {
    it("lists the caller's places newest first, and never another user's", async () => {
      const a = await user();
      const b = await user();
      const [p1, p2, p3, pb] = [await place('First'), await place('Second'), await place('Third'), await place('Bees')];
      for (const [p, days] of [
        [p1, 3],
        [p2, 2],
        [p3, 1],
      ] as const) {
        await owner.query(
          `INSERT INTO saved_places (user_id, place_id, created_at) VALUES ($1, $2, now() - make_interval(days => $3))`,
          [a, p, days],
        );
      }
      await owner.query('INSERT INTO saved_places (user_id, place_id) VALUES ($1, $2)', [b, pb]);

      const list = await quests.savedPlaces(a);
      expect(list.map((s) => s.name)).toEqual(['Third', 'Second', 'First']);
      expect(list[0]).toEqual({
        id: p3,
        name: 'Third',
        lat: expect.closeTo(HERE.lat, 6),
        lng: expect.closeTo(HERE.lng, 6),
        category: 'cafe',
        savedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect((await quests.savedPlaces(b)).map((s) => s.name)).toEqual(['Bees']);
      expect(await quests.savedPlaces(await user())).toEqual([]);
    });

    it('returns at most 100, newest first', async () => {
      const u = await user();
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
         SELECT 'test-saved-bulk-' || gen_random_uuid(), 'Bulk ' || g, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                '{cafe}', 'test-saved-bulk', '{cafe}', array_fill(0, ARRAY[160])::vector, 0.9
         FROM generate_series(1, 105) g RETURNING id::text`,
        [HERE.lng, HERE.lat],
      );
      placeIds.push(...rows.map((r) => r.id));
      await owner.query(
        `INSERT INTO saved_places (user_id, place_id, created_at)
         SELECT $1, x, now() - make_interval(secs => i) FROM unnest($2::bigint[]) WITH ORDINALITY t(x, i)`,
        [u, rows.map((r) => r.id)],
      );
      const list = await quests.savedPlaces(u);
      expect(list).toHaveLength(100);
      expect(list[0].id).toBe(rows[0].id); // the first inserted is the newest (smallest offset)
    });
  });

  it('deleting a quest keeps its place saved; deleting the user takes the saved places', async () => {
    const u = await user();
    const p = await place();
    const q = await quest(u, p, 'offered');
    await quests.act(u, q, 'accept');
    await owner.query('DELETE FROM quests WHERE id = $1', [q]);
    expect(await saved(u)).toEqual([{ place_id: p, quest_id: null }]);
    await owner.query('DELETE FROM users WHERE id = $1', [u]);
    expect((await owner.query('SELECT 1 FROM saved_places WHERE user_id = $1', [u])).rows).toHaveLength(0);
  });

  it('the API role can read and insert saved places, and never update or delete them', async () => {
    const u = await user();
    await pool.query('INSERT INTO saved_places (user_id, place_id) VALUES ($1, $2)', [u, await place()]);
    await expect(pool.query('DELETE FROM saved_places WHERE user_id = $1', [u])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('UPDATE saved_places SET quest_id = NULL WHERE user_id = $1', [u])).rejects.toMatchObject({
      code: '42501',
    });
  });
});
