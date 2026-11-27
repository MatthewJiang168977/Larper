import { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { createPool } from '../db/db.module';
import { assertDisposableDatabase } from '../db/test-guard';
import { deckFor, RADIUS_M } from '../eval/eval';
import type { TagsService } from '../profile/tags.service';
import type { AreasService } from '../quests/areas.service';
import { QuestsService } from '../quests/quests.service';
import { snapshot } from './eval-snapshot';
import { loadFunnel } from './funnel-report';
import { goldenRows } from './golden-export';

// The pick-quality scripts' SQL against a real database, as the API's role. The places sit at
// one of the eval's points; nothing else in the specs does.
const URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? URL;
const describeDb = URL ? describe : describe.skip;
const AT = { lat: 40.7359, lng: -73.9906 };

describeDb('pick-quality queries (real database)', () => {
  let pool: Pool;
  let owner: Pool;
  const placeIds: string[] = [];
  const userIds: string[] = [];

  const place = async (name: string, northM: number, confidence: number) => {
    const { rows } = await owner.query<{ id: string; overtureId: string }>(
      `INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
       VALUES ('test-quality-' || gen_random_uuid(), $1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
               '{food_and_drink,cafe}', 'test-quality-' || gen_random_uuid(), '{cafe}', array_fill(0, ARRAY[160])::vector, $4::real)
       RETURNING id::text, overture_id AS "overtureId"`,
      [name, AT.lng, AT.lat + northM / 111_320, confidence],
    );
    placeIds.push(rows[0].id);
    return rows[0];
  };
  const user = async () => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO users (clerk_id) VALUES ('test_quality_' || gen_random_uuid()) RETURNING id::text`,
    );
    userIds.push(rows[0].id);
    return rows[0].id;
  };

  beforeAll(async () => {
    pool = createPool(URL);
    owner = createPool(OWNER_URL);
    await assertDisposableDatabase(owner, 'quality.db.spec');
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

  it('exports the latest verdict per place as the golden set, notes only when asked', async () => {
    const a = await place('Golden A', 0, 0.9);
    await owner.query(
      `INSERT INTO place_facts (place_id, kind, note, created_at) VALUES
         ($1, 'closed', NULL, '2026-11-01T12:00:00Z'), ($1, 'great', NULL, '2026-11-02T12:00:00Z'),
         ($1, 'note', 'ask for the back', '2026-11-02T12:00:00Z')`,
      [a.id],
    );
    const mine = async (notes: boolean) => (await goldenRows(pool, notes)).filter((r) => r.overtureId === a.overtureId);
    expect(await mine(false)).toEqual([{ overtureId: a.overtureId, rating: 'great', note: '', ratedAt: '2026-11-02' }]);
    expect((await mine(true))[0].note).toBe('ask for the back');
  });

  it('reads the funnel without excluded users or simulated check-ins', async () => {
    const p = await place('Funnel Spot', 30, 0.9);
    const real = await user();
    const mine = await user();
    const insert = (userId: string, status: string, reasons: object) =>
      owner.query(
        `INSERT INTO quests (user_id, place_id, status, score, reasons, accepted_at, completed_at, worth_it, worth_it_at)
         VALUES ($1, $2, $3::quest_status, 1, $4::jsonb, now(), now(), 'yes', now())`,
        [userId, p.id, status, JSON.stringify(reasons)],
      );
    await insert(real, 'completed', {});
    await insert(real, 'completed', { simulated: true });
    await insert(mine, 'completed', {});
    const rows = (await loadFunnel(pool, [mine])).filter((q) => [real, mine].includes(q.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: real, worthIt: 'yes', wasOpen: null });
  });

  // The eval does the SQL part of ranking in memory: it must pick what the service picks.
  it('ranks a snapshot in the same order as the service', async () => {
    await place('Order Near', 60, 0.72);
    await place('Order Sure', 400, 0.99);
    await place('Order Far', 900, 0.8);
    const cache = { getOrSet: async (_k: string, _t: number, fn: () => Promise<unknown>) => ({ value: await fn(), hit: false }) };
    const stats = { total: 0, tagCounts: {} };
    const quests = new QuestsService(
      pool,
      { getOrSet: async (k: string, t: number, fn: () => Promise<unknown>) => (k.startsWith('area:') ? { value: stats, hit: true } : cache.getOrSet(k, t, fn)) } as unknown as CacheService,
      { ready: async () => undefined, slotOf: () => undefined } as unknown as TagsService,
      { survey: async () => ({ pending: [], failed: [], outside: [] }) } as unknown as AreasService,
    );
    const res = await quests.today(await user(), AT.lat, AT.lng, RADIUS_M);
    const served = [res.quest!.place.id, ...res.deck.map((d) => d.place.id)];
    const places = (await snapshot(pool)).filter((p) => placeIds.includes(p.id));
    // No area stats in either: rarity is 0, and with no taste the order is the other terms'.
    const offline = deckFor(places, [], new Map(), AT).map((p) => p.id);
    expect(served.filter((id) => placeIds.includes(id))).toEqual(offline);
  });
});
