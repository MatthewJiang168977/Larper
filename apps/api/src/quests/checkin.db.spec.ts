import { Logger, UnprocessableEntityException } from '@nestjs/common';
import { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { createPool } from '../db/db.module';
import { assertDisposableDatabase } from '../db/test-guard';
import type { TagsService } from '../profile/tags.service';
import type { AreasService } from './areas.service';
import { QuestsService } from './quests.service';

// The check-in path end to end against a real database: the geofence query, the 422
// bodies the web app reads, and one structured log line per attempt. Skipped unless
// TEST_DATABASE_URL is set (CI's db job sets it), and refuses to run (fails) unless that
// is a disposable database with no outbox relay. It brings its own user, place and
// quest, and deletes them (and the outbox rows its check-ins write) afterwards.
const URL = process.env.TEST_DATABASE_URL;
const describeDb = URL ? describe : describe.skip;

// A place at Washington Square Arch, and points measured from it.
const PLACE = { lat: 40.7312, lng: -73.9971 };
const metersNorth = (m: number) => ({ lat: PLACE.lat + m / 111_320, lng: PLACE.lng });

describeDb('check-in (real database)', () => {
  let pool: Pool;
  let quests: QuestsService;
  let userId: string;
  let placeId: string;
  let lines: string[];

  beforeAll(async () => {
    pool = createPool(URL);
    // Before writing anything: never against a live stack (see db/test-guard.ts).
    await assertDisposableDatabase(pool, 'checkin.db.spec');
    quests = new QuestsService(pool, {} as CacheService, {} as TagsService, {} as AreasService);
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (clerk_id) VALUES ('test_checkin_' || gen_random_uuid()) RETURNING id::text`,
    );
    userId = u.rows[0].id;
    const p = await pool.query<{ id: string }>(
      `INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
       VALUES ('test-checkin-' || gen_random_uuid(), 'Test Arch',
               ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, '{cafe}', 'test-arch', '{cafe}',
               array_fill(0, ARRAY[160])::vector, 0.9)
       RETURNING id::text`,
      [PLACE.lng, PLACE.lat],
    );
    placeId = p.rows[0].id;
  });

  afterAll(async () => {
    if (!userId) return pool.end(); // refused before writing anything
    await pool.query('DELETE FROM outbox WHERE key = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]); // cascades to quests
    await pool.query('DELETE FROM places WHERE id = $1', [placeId]);
    await pool.end();
  });

  let questId: string;
  beforeEach(async () => {
    lines = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void lines.push(String(m)));
    await pool.query(`DELETE FROM quests WHERE user_id = $1`, [userId]);
    const q = await pool.query<{ id: string }>(
      `INSERT INTO quests (user_id, place_id, status, score, reasons, origin)
       VALUES ($1, $2, 'accepted', 1, '{}', ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography)
       RETURNING id::text`,
      [userId, placeId, PLACE.lng, PLACE.lat],
    );
    questId = q.rows[0].id;
  });
  afterEach(() => jest.restoreAllMocks());

  const logged = () => {
    const checkins = lines.filter((l) => l.startsWith('checkin '));
    expect(checkins).toHaveLength(1); // exactly one line per attempt
    return JSON.parse(checkins[0].slice('checkin '.length));
  };
  const statusOf = async () =>
    (await pool.query<{ status: string }>('SELECT status FROM quests WHERE id = $1', [questId])).rows[0].status;
  const rejected = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    return (err as UnprocessableEntityException).getResponse();
  };

  it('accepts a check-in at the door, and logs it', async () => {
    await expect(quests.act(userId, questId, 'complete', { ...metersNorth(30), accuracyM: 12 })).resolves.toEqual({
      id: questId,
      status: 'completed',
    });
    expect(logged()).toMatchObject({ questId, outcome: 'accepted', accuracyM: 12, allowedM: 87 });
    expect(logged()).not.toHaveProperty('userId');
    expect(logged().distanceM).toBeCloseTo(30, 0);
  });

  it("rejects a confident miss with 'too_far' and the distance", async () => {
    const body = await rejected(quests.act(userId, questId, 'complete', { ...metersNorth(400), accuracyM: 15 }));
    expect(body).toMatchObject({ code: 'too_far', message: expect.stringMatching(/^You're (39\d|40\d) m away/) }); // geodesic, ~400
    expect(logged()).toMatchObject({ outcome: 'too_far', accuracyM: 15, allowedM: 90 });
    expect(await statusOf()).toBe('accepted'); // nothing changed
  });

  it("rejects a fix too rough to tell with 'too_rough'", async () => {
    const body = await rejected(quests.act(userId, questId, 'complete', { ...metersNorth(250), accuracyM: 900 }));
    expect(body).toMatchObject({ code: 'too_rough', accuracyM: 900 });
    expect(logged()).toMatchObject({ outcome: 'too_rough', accuracyM: 900, allowedM: 125 });
    expect(await statusOf()).toBe('accepted');
  });

  it('logs an attempt without a position', async () => {
    await expect(quests.act(userId, questId, 'complete')).rejects.toThrow('needs your position');
    expect(logged()).toMatchObject({ outcome: 'no_position', distanceM: null });
  });

  it('logs a check-in on a quest that is already completed as a conflict', async () => {
    await quests.act(userId, questId, 'complete', { ...metersNorth(10), accuracyM: 10 });
    lines = [];
    await expect(quests.act(userId, questId, 'complete', { ...metersNorth(10), accuracyM: 10 })).rejects.toThrow(
      'cannot complete a quest that is completed',
    );
    expect(logged()).toMatchObject({ outcome: 'conflict' });
  });

  it('logs nothing for actions other than check-in', async () => {
    await quests.act(userId, questId, 'skip');
    expect(lines.filter((l) => l.startsWith('checkin '))).toHaveLength(0);
  });
});
