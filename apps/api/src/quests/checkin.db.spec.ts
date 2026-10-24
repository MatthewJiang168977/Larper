import { Logger, UnprocessableEntityException } from '@nestjs/common';
import { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { createPool } from '../db/db.module';
import { assertDisposableDatabase } from '../db/test-guard';
import type { TagsService } from '../profile/tags.service';
import type { AreasService } from './areas.service';
import { QuestsService } from './quests.service';

// The check-in path end to end against a real database: the geofence query, the 422
// bodies the web app reads, one structured log line per attempt, and the stored attempt
// (migration 0014) with its 90-day pruning. Skipped unless
// TEST_DATABASE_URL is set (CI's db job sets it), and refuses to run (fails) unless that
// is a disposable database with no outbox relay. It brings its own user, place and
// quest, and deletes them (and the outbox rows its check-ins write) afterwards.
//
// The service runs as TEST_DATABASE_URL's role (the API's, larper_api, in CI), so its
// grants are tested too. The fixtures and the cleanup need more than the API may do
// (it never deletes), so they use TEST_OWNER_DATABASE_URL, the schema owner, when set.
const URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? URL;
const describeDb = URL ? describe : describe.skip;

// A place at Washington Square Arch, and points measured from it.
const PLACE = { lat: 40.7312, lng: -73.9971 };
const metersNorth = (m: number) => ({ lat: PLACE.lat + m / 111_320, lng: PLACE.lng });

describeDb('check-in (real database)', () => {
  let pool: Pool;
  let owner: Pool;
  let quests: QuestsService;
  let userId: string;
  let placeId: string;
  let lines: string[];
  let startedAt: Date;

  beforeAll(async () => {
    pool = createPool(URL);
    owner = createPool(OWNER_URL);
    // Before writing anything: never against a live stack (see db/test-guard.ts).
    await assertDisposableDatabase(owner, 'checkin.db.spec');
    startedAt = (await owner.query<{ now: Date }>('SELECT now()')).rows[0].now;
    quests = new QuestsService(pool, {} as CacheService, {} as TagsService, {} as AreasService);
    const u = await owner.query<{ id: string }>(
      `INSERT INTO users (clerk_id) VALUES ('test_checkin_' || gen_random_uuid()) RETURNING id::text`,
    );
    userId = u.rows[0].id;
    const p = await owner.query<{ id: string }>(
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
    if (userId) {
      await owner.query('DELETE FROM outbox WHERE key = $1', [userId]);
      await owner.query('DELETE FROM users WHERE id = $1', [userId]); // cascades to quests and their attempts
      // Attempts stored without a quest (not_found) don't cascade.
      await owner.query('DELETE FROM checkin_attempts WHERE quest_id IS NULL AND created_at >= $1', [startedAt]);
      await owner.query('DELETE FROM places WHERE id = $1', [placeId]);
    } // else refused before writing anything
    await pool.end();
    await owner.end();
  });

  let questId: string;
  beforeEach(async () => {
    lines = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void lines.push(String(m)));
    await owner.query(`DELETE FROM quests WHERE user_id = $1`, [userId]);
    const q = await owner.query<{ id: string }>(
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
  // The attempts stored for this test's quest, oldest first (as the owner: the API can't read them).
  const stored = async (id = questId) =>
    (
      await owner.query<{ outcome: string; distance_m: number | null; accuracy_m: number | null; allowed_m: number | null; demo: boolean }>(
        'SELECT outcome, distance_m, accuracy_m, allowed_m, demo FROM checkin_attempts WHERE quest_id = $1 ORDER BY id',
        [id],
      )
    ).rows;
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

  describe('stored attempts', () => {
    it('stores an accepted check-in with its geofence numbers, and no coordinates', async () => {
      await quests.act(userId, questId, 'complete', { ...metersNorth(30), accuracyM: 12 });
      const rows = await stored();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: 'accepted', accuracy_m: 12, allowed_m: 87, demo: false });
      expect(rows[0].distance_m).toBeCloseTo(30, 0);
      const cols = await owner.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'checkin_attempts'`,
      );
      expect(cols.rows.map((c) => c.column_name)).not.toEqual(expect.arrayContaining(['lat']));
      expect(cols.rows.map((c) => c.column_name).some((c) => /lat|lng|lon|geom|user/.test(c))).toBe(false);
    });

    it('stores rejected attempts too, though their transaction rolls back', async () => {
      await rejected(quests.act(userId, questId, 'complete', { ...metersNorth(400), accuracyM: 15 }));
      await rejected(quests.act(userId, questId, 'complete', { ...metersNorth(250), accuracyM: 900 }));
      await expect(quests.act(userId, questId, 'complete')).rejects.toThrow('needs your position');
      const rows = await stored();
      expect(rows.map((r) => r.outcome)).toEqual(['too_far', 'too_rough', 'no_position']);
      expect(rows[1]).toMatchObject({ accuracy_m: 900, allowed_m: 125 });
      expect(rows[2]).toMatchObject({ distance_m: null, accuracy_m: null, allowed_m: null });
    });

    it("records no quest id for someone else's quest or one that doesn't exist", async () => {
      const other = await owner.query<{ id: string }>(
        `INSERT INTO users (clerk_id) VALUES ('test_checkin_other_' || gen_random_uuid()) RETURNING id::text`,
      );
      try {
        await expect(quests.act(other.rows[0].id, questId, 'complete', metersNorth(10))).rejects.toThrow('no such quest');
        await expect(quests.act(userId, '999999999999', 'complete', metersNorth(10))).rejects.toThrow('no such quest');
        expect(await stored()).toHaveLength(0); // nothing tied to this user's quest
        const orphans = await owner.query<{ outcome: string }>(
          'SELECT outcome FROM checkin_attempts WHERE quest_id IS NULL AND created_at >= $1 ORDER BY id DESC LIMIT 2',
          [startedAt],
        );
        expect(orphans.rows.map((r) => r.outcome)).toEqual(['not_found', 'not_found']);
      } finally {
        await owner.query('DELETE FROM users WHERE id = $1', [other.rows[0].id]);
      }
    });

    it("marks the demo account's attempts", async () => {
      await quests.act(userId, questId, 'complete', { ...metersNorth(10), accuracyM: 10 }, true);
      expect((await stored())[0]).toMatchObject({ outcome: 'accepted', demo: true });
    });

    it("doesn't change the answer when storing fails", async () => {
      const real = pool.query.bind(pool);
      jest.spyOn(pool, 'query').mockImplementation(((text: unknown, ...rest: unknown[]) =>
        typeof text === 'string' && text.includes('checkin_attempts')
          ? Promise.reject(new Error('simulated'))
          : (real as (...a: unknown[]) => unknown)(text, ...rest)) as typeof pool.query);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await expect(quests.act(userId, questId, 'complete', { ...metersNorth(10), accuracyM: 10 })).resolves.toEqual({
        id: questId,
        status: 'completed',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('checkin attempt not recorded'));
      expect(logged()).toMatchObject({ outcome: 'accepted' }); // the log line still has it
    });

    it('stores nothing for actions other than check-in', async () => {
      await quests.act(userId, questId, 'skip');
      expect(await stored()).toHaveLength(0);
    });

    it('prunes attempts past 90 days, as the API role, and keeps the rest', async () => {
      await owner.query(
        `INSERT INTO checkin_attempts (quest_id, outcome, demo, created_at)
         VALUES ($1, 'too_far', false, now() - interval '91 days'), ($1, 'accepted', false, now() - interval '89 days')`,
        [questId],
      );
      const { rows } = await pool.query<{ n: string }>('SELECT prune_checkin_attempts() AS n');
      expect(Number(rows[0].n)).toBeGreaterThanOrEqual(1);
      expect((await stored()).map((r) => r.outcome)).toEqual(['accepted']);
    });
  });
});
