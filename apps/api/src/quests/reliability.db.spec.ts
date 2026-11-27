import { fromBinary } from '@bufbuild/protobuf';
import { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { CurationService } from '../curation/curation.service';
import { createPool } from '../db/db.module';
import { assertDisposableDatabase } from '../db/test-guard';
import { PlaceReportKind, PlaceReportSchema, QuestAction, QuestEventSchema } from '../gen/larper/events/v1/events_pb';
import { DataExportService } from '../privacy/data-export';
import type { TagsService } from '../profile/tags.service';
import type { AreasService } from './areas.service';
import { QuestsService } from './quests.service';

// The API's side of place reliability against a real database (migration 0024): which actions
// emit a PlaceReport, and what today() does with place_reliability. The worker's side is
// workers/cmd/reliability-worker. Places sit in the South Pacific, away from other specs.
const URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? URL;
const describeDb = URL ? describe : describe.skip;

describeDb('place reliability (real database)', () => {
  let pool: Pool;
  let owner: Pool;
  let quests: QuestsService;
  const placeIds: string[] = [];
  const userIds: string[] = [];
  let areaN = 0;
  const spot = () => ({ lat: -38 - 0.1 * ++areaN, lng: -130 });
  type Spot = ReturnType<typeof spot>;

  const place = async (at: Spot, name: string, northM = 0) => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
       VALUES ('test-rel-' || gen_random_uuid(), $1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
               '{food_and_drink,cafe}', 'test-rel-' || gen_random_uuid(), '{cafe}', array_fill(0, ARRAY[160])::vector, 0.9)
       RETURNING id::text`,
      [name, at.lng, at.lat + northM / 111_320],
    );
    placeIds.push(rows[0].id);
    return rows[0].id;
  };
  const user = async () => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO users (clerk_id) VALUES ('test_rel_' || gen_random_uuid()) RETURNING id::text`,
    );
    userIds.push(rows[0].id);
    return rows[0].id;
  };
  /** The PlaceReports in the outbox about this place, oldest first. */
  const reports = async (placeId: string) => {
    const { rows } = await owner.query<{ key: string; payload: Buffer }>(
      `SELECT key, payload FROM outbox WHERE type = $1 ORDER BY id`,
      [PlaceReportSchema.typeName],
    );
    return rows
      .map((r) => ({ key: r.key, ...fromBinary(PlaceReportSchema, r.payload) }))
      .filter((r) => r.placeId === placeId);
  };
  const offered = async (userId: string, at: Spot, demo = false) => (await quests.today(userId, at.lat, at.lng, 1500, demo)).quest!;
  const checkIn = async (userId: string, at: Spot, demo = false) => {
    const quest = await offered(userId, at, demo);
    await quests.act(userId, quest.id, 'accept', undefined, demo);
    await quests.act(userId, quest.id, 'complete', { lat: quest.place.lat, lng: quest.place.lng, accuracyM: 5 }, demo);
    return quest;
  };

  beforeAll(async () => {
    pool = createPool(URL);
    owner = createPool(OWNER_URL);
    await assertDisposableDatabase(owner, 'reliability.db.spec');
    const cache = { getOrSet: async (_k: string, _t: number, fn: () => Promise<unknown>) => ({ value: await fn(), hit: false }) };
    quests = new QuestsService(
      pool,
      cache as unknown as CacheService,
      { ready: async () => undefined, slotOf: () => undefined, tagOf: () => undefined } as unknown as TagsService,
      { survey: async () => ({ pending: [], failed: [], outside: [] }) } as unknown as AreasService,
    );
  });
  afterAll(async () => {
    await owner.query(`DELETE FROM outbox WHERE key = ANY($1::text[])`, [placeIds.map((id) => `place:${id}`)]);
    for (const id of userIds) {
      await owner.query('DELETE FROM outbox WHERE key = $1', [id]);
      await owner.query('DELETE FROM users WHERE id = $1', [id]);
    }
    if (placeIds.length) await owner.query('DELETE FROM places WHERE id = ANY($1::bigint[])', [placeIds]);
    await pool.end();
    await owner.end();
  });

  it('reports a check-in and the first "was it open?" answer', async () => {
    const at = spot();
    const id = await place(at, 'Check-in Spot');
    const u = await user();
    const quest = await checkIn(u, at);
    await quests.wasOpen(u, quest.id, 'no');
    await quests.wasOpen(u, quest.id, 'yes'); // the first answer stands: nothing more
    expect((await reports(id)).map((r) => [r.kind, r.userId, r.questId, r.key])).toEqual([
      [PlaceReportKind.CHECKED_IN, u, quest.id, u],
      [PlaceReportKind.WASNT_OPEN, u, quest.id, u],
    ]);
  });

  it('reports nothing for the demo account, "didn\'t check" or another reason', async () => {
    const at = spot();
    const id = await place(at, 'Quiet Spot');
    await checkIn(await user(), at, true);
    const skip = async (reason: 'closed' | 'too_far', demo: boolean) => {
      const u = await user();
      const quest = await offered(u, at, demo);
      await quests.act(u, quest.id, 'accept', undefined, demo);
      await quests.act(u, quest.id, 'not-today', undefined, demo);
      await quests.giveReason(u, quest.id, reason, demo);
    };
    await skip('closed', true);
    await skip('too_far', false);
    expect(await reports(id)).toEqual([]);
    await skip('closed', false);
    expect((await reports(id)).map((r) => r.kind)).toEqual([PlaceReportKind.SKIPPED_CLOSED]);
  });

  it("reports the curator's verdicts without a user, keyed by the place", async () => {
    const id = await place(spot(), 'Curated Spot');
    const curation = new CurationService(pool);
    const admin = await user();
    for (const kind of ['great', 'closed', 'bad_fit']) await curation.record(admin, id, { kind });
    await curation.record(admin, id, { kind: 'note', note: 'x' });
    expect((await reports(id)).map((r) => [r.kind, r.userId, r.key])).toEqual([
      [PlaceReportKind.HAND_VERIFIED, '', `place:${id}`],
      [PlaceReportKind.HAND_CLOSED, '', `place:${id}`],
    ]);
  });

  it('does not offer a suspended place, demotes a doubtful one, and lists the suspended', async () => {
    const at = spot();
    const gone = await place(at, 'Suspended Spot');
    const doubtful = await place(at, 'Doubtful Spot', 5);
    const fine = await place(at, 'Fine Spot', 10);
    await owner.query(
      `INSERT INTO place_reliability (place_id, successes, failures, suspended_at) VALUES ($1, 0, 3, now()), ($2, 0, 2, NULL)`,
      [gone, doubtful],
    );
    const res = await quests.today(await user(), at.lat, at.lng, 1500);
    // The doubtful one is still offered (its scaled-down score is covered in reliability.spec.ts).
    expect([res.quest!.place.id, ...res.deck.map((d) => d.place.id)].sort()).toEqual([doubtful, fine].sort());
    const list = await new CurationService(pool).list('suspended');
    expect(list.places.find((p) => p.id === gone)).toMatchObject({ reliability: { suspended: true } });
  });

  it('puts the reports in the export, and history deletion removes them and marks the place stale', async () => {
    const id = await place(spot(), 'Exported Spot');
    const u = await user();
    await owner.query(
      `INSERT INTO place_reports (event_id, place_id, user_id, quest_id, kind, occurred_at)
       VALUES (gen_random_uuid(), $1, $2, 1, 'wasnt_open', '2026-11-01T12:00:00Z')`,
      [id, u],
    );
    const tags = { ready: async () => undefined, tagOf: () => undefined } as unknown as TagsService;
    const out = await new DataExportService(pool, tags).export(u);
    expect(out.placeReports).toEqual([
      expect.objectContaining({ kind: 'wasnt_open', reportedAt: '2026-11-01T12:00:00.000Z' }),
    ]);
    await pool.query('SELECT delete_my_history($1)', [u]);
    expect((await owner.query('SELECT 1 FROM place_reports WHERE place_id = $1', [id])).rowCount).toBe(0);
    expect((await owner.query('SELECT stale FROM place_reliability WHERE place_id = $1', [id])).rows).toEqual([{ stale: true }]);
  });

<<<<<<< HEAD
  it('stores the first "worth it?" answer, tells the taste worker once, exports it, and deletes it with history', async () => {
    const at = spot();
    await place(at, 'Worth Spot');
    const u = await user();
    const quest = await checkIn(u, at);
    const before = (await owner.query('SELECT updated_at FROM quests WHERE id = $1', [quest.id])).rows[0].updated_at;
    await expect(quests.worthIt(u, quest.id, 'meh')).resolves.toEqual({ worthIt: 'meh' });
    await expect(quests.worthIt(u, quest.id, 'yes')).resolves.toEqual({ worthIt: 'meh' });
    const events = (await owner.query<{ payload: Buffer }>('SELECT payload FROM outbox WHERE key = $1 AND type = $2 ORDER BY id', [u, QuestEventSchema.typeName])).rows
      .map((r) => fromBinary(QuestEventSchema, r.payload).action);
    expect(events).toEqual([QuestAction.ACCEPTED, QuestAction.COMPLETED, QuestAction.WORTH_IT_MEH]);
    expect((await owner.query('SELECT updated_at FROM quests WHERE id = $1', [quest.id])).rows[0].updated_at).toEqual(before);
    const tags = { ready: async () => undefined, tagOf: () => undefined } as unknown as TagsService;
    const out = await new DataExportService(pool, tags).export(u);
    expect(out.journal[0]).toMatchObject({ worthIt: 'meh', worthItAt: expect.any(String) });
    await pool.query('SELECT delete_my_history($1)', [u]);
    expect((await owner.query('SELECT 1 FROM quests WHERE user_id = $1', [u])).rowCount).toBe(0);
  });

  it('refuses "worth it?" before a check-in or for a simulated one', async () => {
    const at = spot();
    await place(at, 'Early Spot');
    const u = await user();
    const quest = await offered(u, at);
    await expect(quests.worthIt(u, quest.id, 'yes')).rejects.toThrow('only a quest you checked in at');
    await quests.act(u, quest.id, 'accept');
    await quests.act(u, quest.id, 'complete', { lat: 0, lng: 0, accuracyM: 5 }, true);
    await expect(quests.worthIt(u, quest.id, 'yes')).rejects.toThrow('simulated');
=======
  // Deletions lock the shared place_reliability rows: in one order, or two of them deadlock.
  it('lets two people sharing many places delete their history at once, and keeps suspensions', async () => {
    const at = spot();
    const places: string[] = [];
    for (let i = 0; i < 40; i++) places.push(await place(at, `Shared ${i}`, i * 60));
    for (let round = 0; round < 5; round++) {
      const [v, w] = [await user(), await user()];
      const report = (userId: string, ids: string[]) =>
        owner.query(
          `INSERT INTO place_reports (event_id, place_id, user_id, quest_id, kind, occurred_at)
           SELECT gen_random_uuid(), id, $2, 1, 'wasnt_open', now() FROM unnest($1::bigint[]) AS id`,
          [ids, userId],
        );
      await report(v, places);
      await report(w, [places[31], places[7]]);
      await owner.query(
        `INSERT INTO place_reliability (place_id, suspended_at) SELECT id, now() FROM unnest($1::bigint[]) AS id
         ON CONFLICT (place_id) DO UPDATE SET suspended_at = now()`,
        [places],
      );
      await Promise.all([v, w].map((id) => pool.query('SELECT delete_my_history($1)', [id])));
      const { rows } = await owner.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM place_reliability WHERE place_id = ANY($1::bigint[]) AND suspended_at IS NOT NULL AND stale',
        [places],
      );
      expect(rows[0].n).toBe(places.length);
    }
>>>>>>> feat/reliability-loop
  });
});
