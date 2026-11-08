import { ConflictException, Logger, UnprocessableEntityException } from '@nestjs/common';
import { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { createPool } from '../db/db.module';
import { assertDisposableDatabase } from '../db/test-guard';
import type { TagsService } from '../profile/tags.service';
import type { AreasService } from './areas.service';
import { QuestsService } from './quests.service';
import type { Scored } from './scoring';

// The facts a quest keeps for the profile stats (migration 0016): when it was accepted,
// when it was checked in, and how rare it was when offered. Ranking is stubbed to one
// fixed lead. Same rules as checkin.db.spec: skipped unless TEST_DATABASE_URL is set,
// refuses a live stack, runs as the API's role in CI, brings and deletes its own rows.
const URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? URL;
const describeDb = URL ? describe : describe.skip;

// Far from the other suites' places.
const HERE = { lat: -33.4372, lng: -70.6506, accuracyM: 10 };
const FAR = { lat: -33.5372, lng: -70.6506, accuracyM: 10 }; // about 11 km south

interface Facts {
  status: string;
  accepted_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
  rarity: number | null;
  reasons: Record<string, unknown>;
}

describeDb('quest facts (real database)', () => {
  let pool: Pool;
  let owner: Pool;
  let quests: QuestsService;
  let userId: string;
  let placeId: string;

  const cache = { getOrSet: async (_k: string, _t: number, fn: () => Promise<unknown>) => ({ value: await fn(), hit: false }) };
  const areas = { survey: async () => ({ pending: [], failed: [], outside: [] }) };

  beforeAll(async () => {
    pool = createPool(URL);
    owner = createPool(OWNER_URL);
    await assertDisposableDatabase(owner, 'quest-facts.db.spec');
    quests = new QuestsService(pool, cache as unknown as CacheService, {} as TagsService, areas as unknown as AreasService);
    userId = (
      await owner.query<{ id: string }>(
        `INSERT INTO users (clerk_id) VALUES ('test_quest_facts_' || gen_random_uuid()) RETURNING id::text`,
      )
    ).rows[0].id;
    placeId = (
      await owner.query<{ id: string }>(
        `INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
         VALUES ('test-facts-' || gen_random_uuid(), 'Test Facts Cafe',
                 ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, '{cafe}', 'test-facts', '{cafe}',
                 array_fill(0, ARRAY[160])::vector, 0.9)
         RETURNING id::text`,
        [HERE.lng, HERE.lat],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    if (userId) {
      await owner.query('DELETE FROM outbox WHERE key = $1', [userId]);
      await owner.query('DELETE FROM users WHERE id = $1', [userId]); // cascades to quests and their attempts
      await owner.query('DELETE FROM places WHERE id = $1', [placeId]);
    }
    await pool.end();
    await owner.end();
  });

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await owner.query('DELETE FROM quests WHERE user_id = $1', [userId]);
  });
  afterEach(() => jest.restoreAllMocks());

  const facts = async (id: string) =>
    (
      await owner.query<Facts>(
        'SELECT status, accepted_at, completed_at, updated_at, rarity, reasons FROM quests WHERE id = $1',
        [id],
      )
    ).rows[0];

  const lead = (rarity: number): Scored => ({
    id: placeId, name: 'Test Facts Cafe', lat: HERE.lat, lng: HERE.lng, category: 'cafe', tags: ['cafe'],
    taste: 0.5, chainLocations: 1, confidence: 0.9, distanceM: 0, website: null, instagram: null, phone: null,
    score: 0.8, parts: { fit: 1, rarity, indie: 1, quality: 1, decay: 1 },
    reasons: { liked: [], rarest: { tag: 'cafe', nearby: 3 }, indie: true },
  });

  // Offers a quest the way GET /quests/today does.
  const offered = async (rarity = 0.25) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(quests as any, 'rank').mockResolvedValue([lead(rarity)]);
    const { quest } = await quests.today(userId, HERE.lat, HERE.lng, 1500);
    return quest!.id;
  };
  const accepted = async () => {
    const id = await offered();
    await quests.act(userId, id, 'accept');
    return id;
  };

  // What an older pod, or the time before the migration, leaves behind.
  const legacy = async (status: string) =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO quests (user_id, place_id, status, score, reasons, origin)
         VALUES ($1, $2, $3, 1, '{}', ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography)
         RETURNING id::text`,
        [userId, placeId, status, HERE.lng, HERE.lat],
      )
    ).rows[0].id;

  describe('rarity', () => {
    it('keeps the rarity part of the score from the offer, and nothing else yet', async () => {
      const f = await facts(await offered(0.25));
      expect(f).toMatchObject({ status: 'offered', rarity: 0.25, accepted_at: null, completed_at: null });
    });

    it('stores a rarity of zero as zero, not as unknown', async () => {
      expect((await facts(await offered(0))).rarity).toBe(0);
    });

    it('keeps it through the rest of the quest', async () => {
      const id = await accepted();
      await quests.act(userId, id, 'complete', HERE);
      expect((await facts(id)).rarity).toBe(0.25);
    });
  });

  describe('accepted_at and completed_at', () => {
    it('accepting stamps accepted_at at the same moment as updated_at', async () => {
      const f = await facts(await accepted());
      expect(f.status).toBe('accepted');
      expect(f.accepted_at).toEqual(f.updated_at);
      expect(f.completed_at).toBeNull();
    });

    it('checking in stamps completed_at and leaves accepted_at as it was', async () => {
      const id = await accepted();
      const before = (await facts(id)).accepted_at;
      await quests.act(userId, id, 'complete', HERE);
      const f = await facts(id);
      expect(f.status).toBe('completed');
      expect(f.completed_at).toEqual(f.updated_at);
      expect(f.accepted_at).toEqual(before);
    });

    it('skipping an offer was never an accept', async () => {
      const id = await offered();
      await quests.act(userId, id, 'skip');
      expect(await facts(id)).toMatchObject({ status: 'skipped', accepted_at: null, completed_at: null });
    });

    it.each(['skip', 'not-today'] as const)('%s after accepting keeps the accept', async (action) => {
      const id = await accepted();
      const before = (await facts(id)).accepted_at;
      await quests.act(userId, id, action);
      const f = await facts(id);
      expect(f.status).toBe('skipped');
      expect(f.accepted_at).toEqual(before);
      expect(f.completed_at).toBeNull();
    });

    it('giving a reason later changes neither', async () => {
      const id = await accepted();
      await quests.act(userId, id, 'not-today');
      const before = await facts(id);
      await quests.giveReason(userId, id, 'not_my_thing');
      const f = await facts(id);
      expect(f.accepted_at).toEqual(before.accepted_at);
      expect(f.completed_at).toBeNull();
    });

    it('a stale second accept is refused and keeps the first one', async () => {
      const id = await accepted();
      const before = (await facts(id)).accepted_at;
      await expect(quests.act(userId, id, 'accept')).rejects.toBeInstanceOf(ConflictException);
      expect((await facts(id)).accepted_at).toEqual(before);
    });

    it('a check-in the geofence refuses stamps nothing', async () => {
      const id = await accepted();
      await expect(quests.act(userId, id, 'complete', FAR)).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(await facts(id)).toMatchObject({ status: 'accepted', completed_at: null });
    });

    it('a simulated demo check-in is stamped like any other, and stays marked', async () => {
      const id = await accepted();
      await expect(quests.act(userId, id, 'complete', FAR, true)).resolves.toMatchObject({ simulated: true });
      const f = await facts(id);
      expect(f.completed_at).toEqual(f.updated_at);
      expect(f.reasons).toMatchObject({ simulated: true, rarest: { tag: 'cafe', nearby: 3 } });
    });
  });

  describe('rows from before the migration', () => {
    it('a quest accepted before it can still be checked in, with no accepted_at or rarity', async () => {
      const id = await legacy('accepted');
      await quests.act(userId, id, 'complete', HERE);
      const f = await facts(id);
      expect(f).toMatchObject({ status: 'completed', accepted_at: null, rarity: null });
      expect(f.completed_at).toEqual(f.updated_at);
    });

    it('a quest completed before it keeps NULLs', async () => {
      expect(await facts(await legacy('completed'))).toMatchObject({ accepted_at: null, completed_at: null, rarity: null });
    });
  });
});
