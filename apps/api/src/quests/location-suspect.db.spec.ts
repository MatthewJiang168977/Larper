import { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { createPool } from '../db/db.module';
import { assertDisposableDatabase } from '../db/test-guard';
import type { TagsService } from '../profile/tags.service';
import type { AreasService } from './areas.service';
import { QuestsService } from './quests.service';
import type { Candidate } from './scoring';

// A place whose point is suspect (places.location_suspect, migration 0015: its address
// says it's elsewhere) never becomes a candidate, however close its point is. On
// 2026-10-24 "VerKeerderkill Falls" (the Catskills, pinned in Manhattan) was a lead in
// a Union Square deck. Skipped unless TEST_DATABASE_URL is set; fixtures (and their
// cleanup) need the owner, TEST_OWNER_DATABASE_URL, as the API never deletes.
const URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? URL;
const describeDb = URL ? describe : describe.skip;

// Far from any real data: nothing else is within the radius.
const AT = { lat: -60.5, lng: 10.5 };

type WithCandidates = { candidates(userId: string, lat: number, lng: number, radiusM: number): Promise<Candidate[]> };

describeDb('suspect places stay out of decks (real database)', () => {
  let pool: Pool;
  let owner: Pool;
  let quests: WithCandidates;

  beforeAll(async () => {
    pool = createPool(URL);
    owner = createPool(OWNER_URL);
    await assertDisposableDatabase(owner, 'location-suspect.db.spec');
    quests = new QuestsService(pool, {} as CacheService, {} as TagsService, {} as AreasService) as unknown as WithCandidates;
    for (const [key, suspect] of [
      ['here', null],
      ['elsewhere', 'reported: test'],
    ] as const) {
      await owner.query(
        `INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence, location_suspect)
         VALUES ($1, $1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, '{cafe}', $1, '{cafe}',
                 array_fill(0::real, ARRAY[160])::vector, 0.9, $4)`,
        [`test-suspect-${key}`, AT.lng, AT.lat, suspect],
      );
    }
  });

  afterAll(async () => {
    await owner?.query(`DELETE FROM places WHERE overture_id LIKE 'test-suspect-%'`);
    await pool?.end();
    await owner?.end();
  });

  it('offers the place whose address agrees, not the one whose address says elsewhere', async () => {
    const names = (await quests.candidates('0', AT.lat, AT.lng, 500)).map((c) => c.name);
    expect(names).toContain('test-suspect-here');
    expect(names).not.toContain('test-suspect-elsewhere');
  });
});
