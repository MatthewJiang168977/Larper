import { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { createPool } from '../db/db.module';
import { assertDisposableDatabase } from '../db/test-guard';
import type { TagsService } from '../profile/tags.service';
import type { AreasService } from './areas.service';
import { BLOCKED_CATEGORIES } from './eligibility';
import { QuestsService } from './quests.service';

// The trust gate against a real database (eligibility.spec.ts has the rules' own tests):
// a blocked-category place, a low-confidence place and a duplicate never reach the quest
// or the leads of today(), and the first two not even the candidates query. Skipped
// unless TEST_DATABASE_URL is set; same setup as the other db specs (the service as the
// API's role, fixtures and cleanup as the owner). The places sit in Sydney, so a
// database that holds real NYC places never mixes them in.
const URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? URL;
const describeDb = URL ? describe : describe.skip;

const HERE = { lat: -33.9, lng: 151.2 };
const RADIUS = 1500;
const M_PER_DEG_LAT = 111_320;

describeDb('the trust gate (real database)', () => {
  let pool: Pool;
  let owner: Pool;
  let quests: QuestsService;
  const placeIds: string[] = [];
  const userIds: string[] = [];
  const idOf: Record<string, string> = {}; // by place name

  const cache = { getOrSet: async (_k: string, _t: number, fn: () => Promise<unknown>) => ({ value: await fn(), hit: false }) };
  const areas = { survey: async () => ({ pending: [], failed: [], outside: [] }) };
  const tags = { ready: async () => undefined, slotOf: () => undefined } as unknown as TagsService;
  const service = (gate = { minConfidence: 0.7, eveningUnknownHours: false }, c: unknown = cache) => {
    const q = new QuestsService(pool, c as CacheService, tags, areas as unknown as AreasService);
    q.gate = gate;
    return q;
  };

  const place = async (name: string, categories: string[], confidence: number, northM: number) => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
       VALUES ('test-trust-gate-' || gen_random_uuid(), $1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
               $4::text[], 'test-trust-' || gen_random_uuid(), '{cafe}', array_fill(0, ARRAY[160])::vector, $5::real)
       RETURNING id::text`,
      [name, HERE.lng, HERE.lat + northM / M_PER_DEG_LAT, categories, confidence],
    );
    placeIds.push(rows[0].id);
    idOf[name] = rows[0].id;
  };
  const user = async () => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO users (clerk_id) VALUES ('test_trustgate_' || gen_random_uuid()) RETURNING id::text`,
    );
    userIds.push(rows[0].id);
    return rows[0].id;
  };

  // What may be offered; every other place below must never appear.
  const ELIGIBLE = ['Alpha Cafe', 'Beta Books', 'Edge Spot', 'Green Park', 'Library Branch', 'Twin Cafe Best', 'Harbor B&B', 'Campus Museum', 'Holiday Rental'].sort();

  beforeAll(async () => {
    pool = createPool(URL);
    owner = createPool(OWNER_URL);
    await assertDisposableDatabase(owner, 'trust-gate.db.spec');
    quests = service();

    await place('Alpha Cafe', ['food_and_drink', 'casual_eatery', 'cafe'], 0.9, 10);
    await place('Beta Books', ['shopping', 'specialty_store', 'books_music_and_video_store'], 0.8, 200);
    await place('Edge Spot', ['food_and_drink', 'cafe'], 0.7, 300); // exactly at the threshold, stored as a float4
    await place('Green Park', ['sports_and_recreation', 'park'], 0.95, 400);
    await place('Library Branch', ['education', 'library'], 0.95, 450); // under the education root
    await place('Harbor B&B', ['lodging', 'bed_and_breakfast'], 0.8, 460); // visitors stay here: kept
    await place('Holiday Rental', ['lodging', 'private_lodging', 'holiday_rental_home'], 0.8, 470); // kept too
    await place('Campus Museum', ['arts_and_entertainment', 'museum', 'art_museum'], 0.8, 480); // a museum on a campus
    // Not eligible:
    await place('Little Learners Day Care', ['services_and_business', 'family_service', 'child_care_and_day_care', 'day_care_preschool'], 0.99, 520);
    await place('Dalton Funeral Home', ['services_and_business', 'family_service', 'funeral_service'], 0.99, 530);
    await place('Borough Courthouse', ['community_and_government', 'government_office', 'courthouse'], 0.99, 540);
    await place('Lucky Casino', ['arts_and_entertainment', 'gaming_venue', 'casino'], 0.99, 550);
    await place('State University', ['education', 'place_of_learning', 'college_university'], 0.99, 560);
    await place('Shaky Spot', ['food_and_drink', 'cafe'], 0.65, 500); // below the threshold
    await place('City Clinic', ['health_care', 'hospital'], 0.99, 600);
    await place('Grace Church', ['cultural_and_historic', 'place_of_worship', 'christian_place_of_worship'], 0.99, 650);
    await place('Public School 9', ['education', 'place_of_learning', 'school'], 0.99, 700);
    await place('Sunset Apartments', ['services_and_business', 'housing_or_property_service', 'apartment'], 0.99, 750);
    await place('Mixed-Case Clinic', ['Food_And_Drink', 'HEALTH_CARE'], 0.99, 800); // the blocklist ignores case
    // A duplicate trio within 10 m: only the highest-confidence one is eligible.
    await place('Twin Cafe', ['food_and_drink', 'cafe'], 0.75, 850);
    await place('The Twin Cafe!', ['food_and_drink', 'cafe'], 0.75, 860);
    await place('Twin  Café', ['food_and_drink', 'cafe'], 0.95, 855);
    idOf['Twin Cafe Best'] = idOf['Twin  Café'];
  });

  afterAll(async () => {
    for (const id of userIds) {
      await owner.query('DELETE FROM outbox WHERE key = $1', [id]);
      await owner.query('DELETE FROM users WHERE id = $1', [id]); // cascades to quests
    }
    if (placeIds.length) await owner.query('DELETE FROM places WHERE id = ANY($1::bigint[])', [placeIds]);
    await pool.end();
    await owner.end();
  });

  // The quest and the leads of one answer, by place name.
  const offered = (r: Awaited<ReturnType<QuestsService['today']>>) => {
    const nameOf = new Map(Object.entries(idOf).map(([n, id]) => [id, n]));
    const ids = [r.quest?.place.id, ...r.deck.map((d) => d.place.id)].filter((x): x is string => !!x);
    return ids.map((id) => (id === idOf['Twin Cafe Best'] ? 'Twin Cafe Best' : (nameOf.get(id) ?? `?${id}`))).sort();
  };

  it('offers only eligible places, as the quest and as leads, and all of them', async () => {
    const r = await quests.today(await user(), HERE.lat, HERE.lng, RADIUS);
    expect(r.quest).not.toBeNull();
    expect(offered(r)).toEqual(ELIGIBLE);
  });

  it('the candidates query leaves out blocked and low-confidence places, so its limit is not spent on them', async () => {
    const rows = await (
      quests as unknown as {
        candidates(u: string, lat: number, lng: number, r: number): Promise<{ name: string }[]>;
      }
    ).candidates(await user(), HERE.lat, HERE.lng, RADIUS);
    // Duplicates are the TypeScript rule's job: all three twins are still candidates here.
    expect(rows.map((c) => c.name).sort()).toEqual(
      [
        'Alpha Cafe',
        'Beta Books',
        'Campus Museum',
        'Edge Spot',
        'Green Park',
        'Harbor B&B',
        'Holiday Rental',
        'Library Branch',
        'The Twin Cafe!',
        'Twin  Café',
        'Twin Cafe',
      ].sort(),
    );
  });

  it('the SQL blocklist is the exported constant, matched case-insensitively', async () => {
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM places p WHERE p.id = ANY($1::bigint[])
         AND EXISTS (SELECT FROM unnest(p.categories) c WHERE lower(c) = ANY($2::text[]))`,
      [placeIds, BLOCKED_CATEGORIES],
    );
    expect(rows[0].n).toBe(10); // clinic, church, school, apartments, the mixed-case clinic, day care, funeral home, courthouse, casino, university
  });

  it('a threshold override reaches the query: at 0.9 only the places at or above it remain', async () => {
    const r = await service({ minConfidence: 0.9, eveningUnknownHours: false }).today(
      await user(),
      HERE.lat,
      HERE.lng,
      RADIUS,
    );
    expect(offered(r)).toEqual(['Alpha Cafe', 'Green Park', 'Library Branch', 'Twin Cafe Best']);
  });

  it('decks are cached under the v4 key, so decks cached before the gate are not served', async () => {
    const keys: string[] = [];
    const spy = {
      getOrSet: async (k: string, _t: number, fn: () => Promise<unknown>) => {
        keys.push(k);
        return { value: await fn(), hit: false };
      },
    };
    await service(undefined, spy).today(await user(), HERE.lat, HERE.lng, RADIUS);
    expect(keys.filter((k) => k.startsWith('deck:'))).toEqual([expect.stringMatching(/^deck:v4:/)]);
  });

  describe('unknown hours in the evening (QUEST_GATE_EVENING_UNKNOWN_HOURS)', () => {
    const EVENING = new Date('2026-07-15T22:00:00Z'); // 18:00 EDT
    const AFTERNOON = new Date('2026-07-15T21:59:59Z'); // 17:59:59 EDT
    const on = () => service({ minConfidence: 0.7, eveningUnknownHours: true });

    it('on, in the evening: no quest and no leads, the usual empty state', async () => {
      const r = await on().today(await user(), HERE.lat, HERE.lng, RADIUS, false, EVENING);
      expect(r.quest).toBeNull();
      expect(r.deck).toEqual([]);
    });

    it('on, a second before 6pm: offers as usual', async () => {
      const r = await on().today(await user(), HERE.lat, HERE.lng, RADIUS, false, AFTERNOON);
      expect(r.quest).not.toBeNull();
      expect(r.deck.length).toBeGreaterThan(0);
    });

    it('off, in the evening: offers as usual', async () => {
      const r = await quests.today(await user(), HERE.lat, HERE.lng, RADIUS, false, EVENING);
      expect(r.quest).not.toBeNull();
    });

    it('on, in the evening: a quest already offered or accepted stays, with no new leads', async () => {
      const u = await user();
      const held = (await quests.today(u, HERE.lat, HERE.lng, RADIUS, false, AFTERNOON)).quest!;
      const r = await on().today(u, HERE.lat, HERE.lng, RADIUS, false, EVENING);
      expect(r.quest).toMatchObject({ id: held.id, status: 'offered' });
      expect(r.deck).toEqual([]);
      await quests.act(u, held.id, 'accept');
      const again = await on().today(u, HERE.lat, HERE.lng, RADIUS, false, EVENING);
      expect(again.quest).toMatchObject({ id: held.id, status: 'accepted' });
    });
  });

  it('a live quest at a place that is no longer eligible is kept, not revoked', async () => {
    const u = await user();
    await owner.query(
      `INSERT INTO quests (user_id, place_id, status, score, reasons, origin)
       VALUES ($1, $2, 'accepted', 1, '{}', ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography)`,
      [u, idOf['City Clinic'], HERE.lng, HERE.lat],
    );
    const r = await quests.today(u, HERE.lat, HERE.lng, RADIUS);
    expect(r.quest?.place.id).toBe(idOf['City Clinic']);
    expect(offered({ ...r, quest: null })).toEqual(ELIGIBLE); // the leads are still only eligible ones
  });
});
