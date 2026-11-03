import { Pool } from 'pg';
import type { AuthUser } from '../auth/auth.guard';
import { createPool } from '../db/db.module';
import { assertDisposableDatabase } from '../db/test-guard';
import { ProfileController } from './profile.controller';
import type { TagsService } from './tags.service';

// The home page asks for today's quest alongside /me, so a new account can hold an offer
// made before it had any taste. The first onboarding drops that offer; a re-seed keeps
// an open one. Same rules as checkin.db.spec: skipped unless TEST_DATABASE_URL is set,
// refuses a live stack, brings and deletes its own rows.
const URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? URL;
const describeDb = URL ? describe : describe.skip;

const HERE = { lat: 40.7312, lng: -73.9971 };

describeDb('onboarding and an offer made before it (real database)', () => {
  let pool: Pool;
  let owner: Pool;
  let profile: ProfileController;
  let user: AuthUser;
  let placeId: string;

  // Every tag in one slot: the taste's shape doesn't matter here, only that it saves.
  const tags = { ready: async () => {}, slotOf: () => 0, tagOf: () => 'cafe' };

  const offer = async () =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO quests (user_id, place_id, status, score, reasons, origin)
         VALUES ($1, $2, 'offered', 1, '{}', ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography)
         RETURNING id::text`,
        [user.id, placeId, HERE.lng, HERE.lat],
      )
    ).rows[0].id;
  const statusOf = async (questId: string) =>
    (await owner.query<{ status: string }>('SELECT status::text FROM quests WHERE id = $1', [questId])).rows[0].status;

  beforeAll(async () => {
    pool = createPool(URL);
    owner = createPool(OWNER_URL);
    await assertDisposableDatabase(owner, 'onboarding.db.spec');
    profile = new ProfileController(pool, tags as unknown as TagsService);
    const clerkId = `test_onboarding_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const id = (await owner.query<{ id: string }>('INSERT INTO users (clerk_id) VALUES ($1) RETURNING id::text', [clerkId]))
      .rows[0].id;
    user = { id, clerkId };
    placeId = (
      await owner.query<{ id: string }>(
        `INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
         VALUES ('test-onboarding-' || gen_random_uuid(), 'Test Onboarding Cafe',
                 ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, '{cafe}', 'test-onb-' || gen_random_uuid(), '{cafe}',
                 array_fill(0, ARRAY[160])::vector, 0.9)
         RETURNING id::text`,
        [HERE.lng, HERE.lat],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    if (user) {
      await owner.query('DELETE FROM users WHERE id = $1', [user.id]); // cascades to quests, taste
      await owner.query('DELETE FROM places WHERE id = $1', [placeId]);
    }
    await pool.end();
    await owner.end();
  });

  it('drops an offer made before the first taste profile', async () => {
    const before = await offer();
    await profile.onboard(user, { liked: ['matcha'] });
    expect(await statusOf(before)).toBe('expired');
  });

  it('keeps an open offer when an onboarded account re-seeds its taste', async () => {
    const open = await offer();
    await profile.onboard(user, { liked: ['boba'] });
    expect(await statusOf(open)).toBe('offered');
  });
});
