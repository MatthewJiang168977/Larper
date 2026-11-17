import { ConflictException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { createPool } from '../db/db.module';
import { assertDisposableDatabase } from '../db/test-guard';
import type { TagsService } from '../profile/tags.service';
import type { AreasService } from './areas.service';
import { QuestsService, type PlaceView, type QuestView } from './quests.service';

// Opening hours against a real database (migration 0018): the table's constraints, hours in
// today()'s answer, the "was it open?" answer, and the trust gate's evening rule on real
// hours. Skipped unless TEST_DATABASE_URL is set; the service runs as the API's role,
// fixtures and cleanup as the owner. The places sit in Sydney, each test in a spot of its
// own, so a database that holds real NYC places (or other specs' rows) never mixes in.
const URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? URL;
const describeDb = URL ? describe : describe.skip;

const RADIUS = 1500;
const M_PER_DEG_LAT = 111_320;
const NOW = new Date('2026-07-15T16:00:00Z'); // Wednesday 12:00 EDT
const EVENING = new Date('2026-07-15T22:00:00Z'); // Wednesday 18:00 EDT

const DAILY_10_TO_23 = { v: 1, tz: 'America/New_York', always: false, weekly: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ d, from: 600, to: 1380 })), dates: [], holidays: 'open', partial: 'none' };
const DAILY_9_TO_17 = { ...DAILY_10_TO_23, weekly: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ d, from: 540, to: 1020 })) };
const WEEKDAYS_9_TO_17 = { ...DAILY_10_TO_23, weekly: [1, 2, 3, 4, 5].map((d) => ({ d, from: 540, to: 1020 })) };

describeDb('opening hours (real database)', () => {
  let pool: Pool;
  let owner: Pool;
  const placeIds: string[] = [];
  const userIds: string[] = [];
  let areaN = 0;

  const cache = { getOrSet: async (_k: string, _t: number, fn: () => Promise<unknown>) => ({ value: await fn(), hit: false }) };
  const areas = { survey: async () => ({ pending: [], failed: [], outside: [] }) };
  const tags = { ready: async () => undefined, slotOf: () => undefined } as unknown as TagsService;
  const service = (evening = false) => {
    const q = new QuestsService(pool, cache as unknown as CacheService, tags, areas as unknown as AreasService);
    q.gate = { minConfidence: 0.7, eveningUnknownHours: evening };
    return q;
  };

  // A spot of its own: places inserted here are the only ones within the radius.
  const spot = () => ({ lat: -34.2 - 0.1 * ++areaN, lng: 150.4 });
  type Spot = ReturnType<typeof spot>;

  const place = async (at: Spot, name: string, northM = 0) => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
       VALUES ('test-hours-' || gen_random_uuid(), $1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
               '{food_and_drink,cafe}', 'test-hours-' || gen_random_uuid(), '{cafe}', array_fill(0, ARRAY[160])::vector, 0.9)
       RETURNING id::text`,
      [name, at.lng, at.lat + northM / M_PER_DEG_LAT],
    );
    placeIds.push(rows[0].id);
    return rows[0].id;
  };
  const user = async () => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO users (clerk_id) VALUES ('test_hours_' || gen_random_uuid()) RETURNING id::text`,
    );
    userIds.push(rows[0].id);
    return rows[0].id;
  };
  interface FactOpts {
    service?: string;
    source?: string;
    sourceUrl?: string | null;
    fetchedAt?: string;
    confidence?: number;
  }
  const scheduleFact = (placeId: string, schedule: unknown, o: FactOpts = {}) =>
    owner.query(
      `INSERT INTO place_hours_facts (place_id, kind, service, source, source_url, fetched_at, confidence, schedule)
       VALUES ($1, 'schedule', $2, $3, $4, $5, $6::real, $7::jsonb)`,
      [placeId, o.service ?? 'regular', o.source ?? 'osm', o.sourceUrl ?? null, o.fetchedAt ?? '2026-06-01T12:00:00Z', o.confidence ?? 0.8, JSON.stringify(schedule)],
    );
  const observation = (placeId: string, userId: string | null, wasOpen: boolean | null, fetchedAt: string, questId: string | null = null) =>
    owner.query(
      `INSERT INTO place_hours_facts (place_id, kind, source, fetched_at, confidence, was_open, quest_id, user_id)
       VALUES ($1, 'observation', 'check-in', $2, 0.9, $3, $4, $5)`,
      [placeId, fetchedAt, wasOpen, questId, userId],
    );
  const quest = async (userId: string, placeId: string, at: Spot, status: string, extra: { reasons?: object; completedAt?: string | null } = {}) =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO quests (user_id, place_id, status, score, reasons, origin, completed_at)
         VALUES ($1, $2, $3::quest_status, 1, $4::jsonb, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7)
         RETURNING id::text`,
        [userId, placeId, status, JSON.stringify(extra.reasons ?? {}), at.lng, at.lat, extra.completedAt === undefined ? null : extra.completedAt],
      )
    ).rows[0].id;
  const factsOfQuest = async (questId: string) =>
    (await owner.query('SELECT * FROM place_hours_facts WHERE quest_id = $1', [questId])).rows;

  const hoursOf = (r: { quest: QuestView | null; deck: { place: PlaceView }[] }, placeId: string): PlaceView => {
    const all = [...(r.quest ? [r.quest.place] : []), ...r.deck.map((d) => d.place)];
    const found = all.find((p) => p.id === placeId);
    if (!found) throw new Error(`place ${placeId} is not in the answer`);
    return found;
  };

  beforeAll(async () => {
    pool = createPool(URL);
    owner = createPool(OWNER_URL);
    await assertDisposableDatabase(owner, 'place-hours.db.spec');
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

  // --- the table ------------------------------------------------------------------

  describe('constraints', () => {
    const sqlstate = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
    const insert = (cols: string, vals: unknown[]) =>
      owner.query(`INSERT INTO place_hours_facts (${cols}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
    const SCHED = JSON.stringify(DAILY_9_TO_17);
    let pid: string;
    beforeAll(async () => {
      pid = await place(spot(), 'Constraint Spot');
    });

    it('a schedule needs its schedule json, and only a schedule has one', async () => {
      const cols = 'place_id, kind, source, fetched_at, confidence, schedule';
      expect(await sqlstate(insert(cols, [pid, 'schedule', 'osm', NOW, 0.8, null]))).toBe('23514');
      expect(await sqlstate(insert(cols, [pid, 'observation', 'check-in', NOW, 0.9, SCHED]))).toBe('23514');
      expect(await sqlstate(insert(cols, [pid, 'schedule', 'manual', NOW, 0.8, SCHED]))).toBe('ok');
    });
    it('an observation is a check-in, and a check-in is an observation', async () => {
      const cols = 'place_id, kind, source, fetched_at, confidence, was_open';
      expect(await sqlstate(insert(cols, [pid, 'observation', 'osm', NOW, 0.9, true]))).toBe('23514');
      expect(await sqlstate(insert('place_id, kind, source, fetched_at, confidence, schedule', [pid, 'schedule', 'check-in', NOW, 0.9, SCHED]))).toBe('23514');
      expect(await sqlstate(insert(cols, [pid, 'observation', 'check-in', NOW, 0.9, true]))).toBe('ok');
    });
    it('only a schedule can name a service other than regular', async () => {
      const cols = 'place_id, kind, service, source, fetched_at, confidence, was_open';
      expect(await sqlstate(insert(cols, [pid, 'observation', 'kitchen', 'check-in', NOW, 0.9, true]))).toBe('23514');
      expect(await sqlstate(insert('place_id, kind, service, source, fetched_at, confidence, schedule', [pid, 'schedule', 'brunch', 'osm', NOW, 0.9, SCHED]))).toBe('23514');
    });
    it('confidence is within 0..1, and the source is one of the known ones', async () => {
      const cols = 'place_id, kind, source, fetched_at, confidence, schedule';
      expect(await sqlstate(insert(cols, [pid, 'schedule', 'website', NOW, 1.1, SCHED]))).toBe('23514');
      expect(await sqlstate(insert(cols, [pid, 'schedule', 'website', NOW, -0.1, SCHED]))).toBe('23514');
      expect(await sqlstate(insert(cols, [pid, 'schedule', 'google', NOW, 0.5, SCHED]))).toBe('23514');
    });
    it('one current schedule per place, service and source', async () => {
      const cols = 'place_id, kind, service, source, fetched_at, confidence, schedule';
      expect(await sqlstate(insert(cols, [pid, 'schedule', 'regular', 'nyc_open_data', NOW, 0.8, SCHED]))).toBe('ok');
      expect(await sqlstate(insert(cols, [pid, 'schedule', 'regular', 'nyc_open_data', NOW, 0.9, SCHED]))).toBe('23505');
      expect(await sqlstate(insert(cols, [pid, 'schedule', 'kitchen', 'nyc_open_data', NOW, 0.9, SCHED]))).toBe('ok'); // another service
      expect(await sqlstate(insert(cols, [pid, 'schedule', 'regular', 'alltheplaces', NOW, 0.9, SCHED]))).toBe('ok'); // another source
    });
    it('one answer per quest; facts without a quest are not limited', async () => {
      const u = await user();
      const q = await quest(u, pid, spot(), 'completed');
      expect(await sqlstate(observation(pid, u, true, NOW.toISOString(), q))).toBe('ok');
      expect(await sqlstate(observation(pid, u, false, NOW.toISOString(), q))).toBe('23505');
      expect(await sqlstate(observation(pid, u, true, NOW.toISOString()))).toBe('ok');
      expect(await sqlstate(observation(pid, u, true, NOW.toISOString()))).toBe('ok');
    });
  });

  // --- hours in today() -----------------------------------------------------------

  describe('hours in the quest response', () => {
    it('are unverified by default, and the confirmations are null: the quest and the leads', async () => {
      const at = spot();
      const a = await place(at, 'Plain Cafe', 0);
      const b = await place(at, 'Plain Books', 100);
      const r = await service().today(await user(), at.lat, at.lng, RADIUS, false, NOW);
      for (const id of [a, b]) {
        const p = hoursOf(r, id);
        expect(p.hours).toEqual({ status: 'unverified' });
        expect(p.openConfirmations).toBeNull();
      }
      expect(r.quest && [r.quest.place.id, ...r.deck.map((d) => d.place.id)].sort()).toEqual([a, b].sort());
    });

    it('known: the state, today, the next change and where it came from, at a fixed now', async () => {
      const at = spot();
      const p = await place(at, 'Known Cafe');
      await scheduleFact(p, WEEKDAYS_9_TO_17, { source: 'osm', sourceUrl: 'https://example.test/osm/node/1', fetchedAt: '2026-06-01T12:00:00Z', confidence: 0.8 });
      const r = await service().today(await user(), at.lat, at.lng, RADIUS, false, NOW);
      expect(hoursOf(r, p).hours).toEqual({
        status: 'known',
        state: 'open',
        today: [{ from: '09:00', to: '17:00', nextDay: false }],
        nextChange: { at: '17:00', to: 'closed' },
        source: 'osm',
        sourceUrl: 'https://example.test/osm/node/1',
        fetchedAt: '2026-06-01T12:00:00.000Z',
        services: [],
      });
      // The same schedule on a Sunday evening: closed (a known schedule says so), opening tomorrow at 09:00.
      const sunday = await service().today(await user(), at.lat, at.lng, RADIUS, false, new Date('2026-07-19T22:00:00Z'));
      expect(hoursOf(sunday, p).hours).toMatchObject({ status: 'known', state: 'closed', today: [], nextChange: { at: '09:00', to: 'open' } });
    });

    it('known and unknown: a schedule that cannot say is "unknown", never closed', async () => {
      const at = spot();
      const p = await place(at, 'Partial Cafe');
      await scheduleFact(p, { ...DAILY_9_TO_17, partial: 'restrictive' });
      const r = await service().today(await user(), at.lat, at.lng, RADIUS, false, NOW);
      expect(hoursOf(r, p).hours).toMatchObject({ status: 'known', state: 'unknown', nextChange: null });
    });

    it('uses the schedule with the highest confidence, then the newest', async () => {
      const at = spot();
      const p = await place(at, 'Contested Cafe');
      await scheduleFact(p, DAILY_9_TO_17, { source: 'osm', confidence: 0.6, fetchedAt: '2026-07-01T00:00:00Z' });
      await scheduleFact(p, DAILY_10_TO_23, { source: 'website', sourceUrl: 'https://example.test/hours', confidence: 0.8, fetchedAt: '2026-05-01T00:00:00Z' });
      let r = await service().today(await user(), at.lat, at.lng, RADIUS, false, NOW);
      expect(hoursOf(r, p).hours).toMatchObject({ source: 'website', today: [{ from: '10:00', to: '23:00', nextDay: false }] });

      // Same confidence: the newer fetch wins.
      await scheduleFact(p, DAILY_9_TO_17, { source: 'manual', confidence: 0.8, fetchedAt: '2026-07-10T00:00:00Z' });
      r = await service().today(await user(), at.lat, at.lng, RADIUS, false, NOW);
      expect(hoursOf(r, p).hours).toMatchObject({ source: 'manual', fetchedAt: '2026-07-10T00:00:00.000Z' });
    });

    it('ignores facts below the confidence floor (0.5 itself counts), and then the place is unverified, not closed', async () => {
      const at = spot();
      const low = await place(at, 'Low Cafe', 0);
      const edge = await place(at, 'Edge Cafe', 100);
      await scheduleFact(low, DAILY_9_TO_17, { confidence: 0.49 });
      await scheduleFact(edge, DAILY_9_TO_17, { confidence: 0.5 });
      const r = await service().today(await user(), at.lat, at.lng, RADIUS, false, NOW);
      expect(hoursOf(r, low).hours).toEqual({ status: 'unverified' });
      expect(hoursOf(r, edge).hours).toMatchObject({ status: 'known', state: 'open' });
    });

    it('ignores an invalid schedule: unverified, never closed; the next valid fact stands in', async () => {
      const at = spot();
      const bad = await place(at, 'Broken Cafe', 0);
      const fallback = await place(at, 'Fallback Cafe', 100);
      await scheduleFact(bad, { v: 1, weekly: 'always' }, { confidence: 0.9 });
      await scheduleFact(fallback, { v: 2 }, { source: 'osm', confidence: 0.95 });
      await scheduleFact(fallback, DAILY_9_TO_17, { source: 'website', confidence: 0.6 });
      const r = await service().today(await user(), at.lat, at.lng, RADIUS, false, NOW);
      expect(hoursOf(r, bad).hours).toEqual({ status: 'unverified' });
      expect(hoursOf(r, fallback).hours).toMatchObject({ status: 'known', source: 'website', state: 'open' });
    });

    it('lists the kitchen and the bar only when they have a schedule; a service alone does not make hours known', async () => {
      const at = spot();
      const both = await place(at, 'Gastropub', 0);
      const kitchenOnly = await place(at, 'Kitchen Only', 100);
      await scheduleFact(both, DAILY_10_TO_23);
      await scheduleFact(both, DAILY_9_TO_17, { service: 'kitchen' });
      await scheduleFact(both, { ...DAILY_9_TO_17, weekly: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ d, from: 1020, to: 1560 })) }, { service: 'bar' });
      await scheduleFact(kitchenOnly, DAILY_9_TO_17, { service: 'kitchen' });
      const r = await service().today(await user(), at.lat, at.lng, RADIUS, false, NOW);
      expect(hoursOf(r, both).hours).toMatchObject({
        status: 'known',
        state: 'open',
        services: [
          { kind: 'kitchen', state: 'open', today: [{ from: '09:00', to: '17:00', nextDay: false }] },
          { kind: 'bar', state: 'closed', today: [{ from: '17:00', to: '02:00', nextDay: true }] },
        ],
      });
      expect(hoursOf(r, kitchenOnly).hours).toEqual({ status: 'unverified' });
    });

    it('open confirmations: distinct people, "open" answers only, the last 180 days, bucketed in New York time', async () => {
      const at = spot();
      const p = await place(at, 'Confirmed Cafe');
      const [u1, u2, u3, u4] = [await user(), await user(), await user(), await user()];
      await observation(p, u1, true, '2026-07-10T01:30:00Z'); // Thursday 21:30 EDT
      await observation(p, u1, true, '2026-07-12T14:00:00Z'); // the same person again (Sunday 10:00 EDT): counted once
      await observation(p, u2, true, '2026-03-20T12:00:00Z'); // 117 days before NOW: counted
      await observation(p, u3, true, '2026-01-10T12:00:00Z'); // 186 days: too old
      await observation(p, u4, false, '2026-07-14T12:00:00Z'); // "no" does not count
      await observation(p, u4, null, '2026-07-14T13:00:00Z'); // "didn't check" does not count
      const r = await service().today(await user(), at.lat, at.lng, RADIUS, false, NOW);
      const c = hoursOf(r, p).openConfirmations;
      // The newest "open" is 2026-07-12 10:00 EDT: a Sunday morning. Nothing else leaves the API.
      expect(c).toEqual({ count: 2, last: { day: 'sun', part: 'morning' } });
      expect(Object.keys(c!.last).sort()).toEqual(['day', 'part']);
      expect(JSON.stringify(c)).toBe('{"count":2,"last":{"day":"sun","part":"morning"}}'); // no dates, no times, no people
      expect(hoursOf(r, p).hours).toEqual({ status: 'unverified' }); // confirmations never make hours known
    });

    it('the 180-day edge is relative to now, and nothing within it from before is counted twice', async () => {
      const at = spot();
      const p = await place(at, 'Window Cafe');
      await observation(p, await user(), true, '2026-01-16T16:00:01Z'); // 180 days minus a second before NOW
      const inside = await service().today(await user(), at.lat, at.lng, RADIUS, false, NOW);
      expect(hoursOf(inside, p).openConfirmations).toMatchObject({ count: 1 });
      const outside = await service().today(await user(), at.lat, at.lng, RADIUS, false, new Date('2026-07-15T16:00:02Z'));
      expect(hoursOf(outside, p).openConfirmations).toBeNull();
    });

    it('also on the quest the user already checked in at today', async () => {
      const at = spot();
      const p = await place(at, 'Done Cafe');
      await scheduleFact(p, DAILY_9_TO_17);
      const u = await user();
      await quest(u, p, at, 'completed', { completedAt: new Date().toISOString() });
      const r = await service().today(u, at.lat, at.lng, RADIUS, false, NOW);
      expect(r.quest?.status).toBe('completed');
      expect(r.quest?.place.hours).toMatchObject({ status: 'known', state: 'open' });
      expect(r.deck).toEqual([]);
    });

    it('costs one extra query per today(), however many places, and the journal gains none', async () => {
      const at = spot();
      for (let i = 0; i < 5; i++) await place(at, `Many ${i}`, i * 50);
      const spy = jest.spyOn(pool, 'query');
      try {
        const u = await user();
        const r = await service().today(u, at.lat, at.lng, RADIUS, false, NOW);
        expect(r.deck.length).toBe(4);
        const hoursQueries = spy.mock.calls.filter(([sql]) => /UNION ALL/.test(String((sql as { text?: string }).text ?? sql)) && /place_hours_facts/.test(String(sql)));
        expect(hoursQueries).toHaveLength(1);
        spy.mockClear();
        const rows = await service().log(u);
        expect(rows.length).toBe(1);
        expect(rows[0]).not.toHaveProperty('hours');
        expect(spy.mock.calls.filter(([sql]) => /place_hours_facts/.test(String(sql)))).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // --- "was it open?" -------------------------------------------------------------

  describe('was it open?', () => {
    const checkedIn = async (opts: { reasons?: object; completedAt?: string | null; status?: string } = {}) => {
      const at = spot();
      const p = await place(at, 'Went Here');
      const u = await user();
      const q = await quest(u, p, at, opts.status ?? 'completed', {
        reasons: opts.reasons,
        completedAt: opts.completedAt === undefined ? '2026-07-14T23:00:00Z' : opts.completedAt,
      });
      return { at, p, u, q };
    };

    it.each([
      ['yes', true, 0.9],
      ['no', false, 0.9],
      ['didnt_check', null, 0],
    ] as const)('"%s" is stored as a check-in fact from the quest row', async (answer, wasOpen, confidence) => {
      const { p, u, q } = await checkedIn();
      expect(await service().wasOpen(u, q, answer)).toEqual({ wasOpen: answer });
      const rows = await factsOfQuest(q);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        place_id: p,
        user_id: u,
        quest_id: q,
        kind: 'observation',
        service: 'regular',
        source: 'check-in',
        source_url: null,
        was_open: wasOpen,
        schedule: null,
        confidence,
      });
      expect(rows[0].fetched_at.toISOString()).toBe('2026-07-14T23:00:00.000Z'); // when the person checked in
    });

    it('a repeat call returns the first answer and changes nothing', async () => {
      const { u, q } = await checkedIn();
      const s = service();
      expect(await s.wasOpen(u, q, 'no')).toEqual({ wasOpen: 'no' });
      expect(await s.wasOpen(u, q, 'yes')).toEqual({ wasOpen: 'no' });
      expect(await s.wasOpen(u, q, 'didnt_check')).toEqual({ wasOpen: 'no' });
      expect(await factsOfQuest(q)).toHaveLength(1);
    });

    it('two calls at once agree on one answer', async () => {
      const { u, q } = await checkedIn();
      const s = service();
      const [a, b] = await Promise.all([s.wasOpen(u, q, 'yes'), s.wasOpen(u, q, 'no')]);
      expect(a).toEqual(b);
      expect(await factsOfQuest(q)).toHaveLength(1);
    });

    it('uses the quest\'s updated_at when completed_at is missing (old rows)', async () => {
      const { u, q } = await checkedIn({ completedAt: null });
      await owner.query(`UPDATE quests SET updated_at = '2026-05-05T10:00:00Z' WHERE id = $1`, [q]);
      await service().wasOpen(u, q, 'yes');
      expect((await factsOfQuest(q))[0].fetched_at.toISOString()).toBe('2026-05-05T10:00:00.000Z');
    });

    it("is a 404 for someone else's quest or no quest, and writes nothing", async () => {
      const { q } = await checkedIn();
      const stranger = await user();
      await expect(service().wasOpen(stranger, q, 'yes')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service().wasOpen(stranger, '999999999999', 'yes')).rejects.toBeInstanceOf(NotFoundException);
      expect(await factsOfQuest(q)).toEqual([]);
    });

    it.each(['offered', 'accepted', 'skipped', 'expired'])('is a 409 while the quest is %s', async (status) => {
      const { u, q } = await checkedIn({ status });
      await expect(service().wasOpen(u, q, 'yes')).rejects.toBeInstanceOf(ConflictException);
      expect(await factsOfQuest(q)).toEqual([]);
    });

    it('is a 409 for a simulated demo check-in: nobody went', async () => {
      const { u, q } = await checkedIn({ reasons: { simulated: true } });
      await expect(service().wasOpen(u, q, 'yes')).rejects.toBeInstanceOf(ConflictException);
      expect(await factsOfQuest(q)).toEqual([]);
    });

    it('QuestView.wasOpen reflects the answer, and the confirmation shows on the place', async () => {
      const { at, p, u, q } = await checkedIn();
      // completed_at is "now" for doneToday() to find it; the quest is today's.
      await owner.query(`UPDATE quests SET completed_at = now(), updated_at = now() WHERE id = $1`, [q]);
      const s = service();
      expect((await s.today(u, at.lat, at.lng, RADIUS)).quest).toMatchObject({ id: q, wasOpen: null });
      await s.wasOpen(u, q, 'yes');
      const after = await s.today(u, at.lat, at.lng, RADIUS);
      expect(after.quest).toMatchObject({ id: q, wasOpen: 'yes' });
      expect(after.quest?.place.id).toBe(p);
      expect(after.quest?.place.openConfirmations).toMatchObject({ count: 1 });
    });

    it.each([
      ['no', 'no'],
      ['didnt_check', 'didnt_check'],
    ] as const)('QuestView.wasOpen says %s', async (answer, shown) => {
      const { at, u, q } = await checkedIn();
      await owner.query(`UPDATE quests SET completed_at = now(), updated_at = now() WHERE id = $1`, [q]);
      await service().wasOpen(u, q, answer);
      expect((await service().today(u, at.lat, at.lng, RADIUS)).quest?.wasOpen).toBe(shown);
    });

    it('deleting the quest keeps the fact, with no quest; deleting the user removes their facts', async () => {
      const { p, u, q } = await checkedIn();
      await service().wasOpen(u, q, 'yes');
      await owner.query('DELETE FROM quests WHERE id = $1', [q]);
      const kept = await owner.query('SELECT quest_id, user_id::text, was_open FROM place_hours_facts WHERE place_id = $1', [p]);
      expect(kept.rows).toEqual([{ quest_id: null, user_id: u, was_open: true }]);
      await owner.query('DELETE FROM users WHERE id = $1', [u]);
      expect((await owner.query('SELECT 1 FROM place_hours_facts WHERE place_id = $1', [p])).rowCount).toBe(0);
    });

    it("the API's role can read and insert facts, never update or delete them", async () => {
      const who = (await pool.query<{ u: string }>('SELECT current_user AS u')).rows[0].u;
      if (who !== 'larper_api') return; // run as the owner, the grants say nothing
      const { u, q } = await checkedIn();
      await service().wasOpen(u, q, 'yes');
      const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
      expect(await code(pool.query('UPDATE place_hours_facts SET was_open = false WHERE quest_id = $1', [q]))).toBe('42501');
      expect(await code(pool.query('DELETE FROM place_hours_facts WHERE quest_id = $1', [q]))).toBe('42501');
      expect((await factsOfQuest(q))[0].was_open).toBe(true);
    });
  });

  // --- the trust gate's evening rule ----------------------------------------------

  describe('the evening rule uses real hours (QUEST_GATE_EVENING_UNKNOWN_HOURS)', () => {
    const names = (r: Awaited<ReturnType<QuestsService['today']>>, byId: Map<string, string>) =>
      [r.quest?.place.id, ...r.deck.map((d) => d.place.id)].filter((x): x is string => !!x).map((id) => byId.get(id)).sort();

    let at: Spot;
    let byId: Map<string, string>;
    let open: string;
    beforeAll(async () => {
      at = spot();
      byId = new Map();
      const add = async (name: string, northM: number, setup?: (id: string) => Promise<unknown>) => {
        const id = await place(at, name, northM);
        byId.set(id, name);
        await setup?.(id);
        return id;
      };
      open = await add('Open Now', 0, (id) => scheduleFact(id, DAILY_10_TO_23));
      await add('Always Open', 40, (id) => scheduleFact(id, { ...DAILY_10_TO_23, always: true, weekly: [], holidays: null }));
      await add('Closed Now', 80, (id) => scheduleFact(id, DAILY_9_TO_17));
      await add('No Hours', 120);
      await add('Confirmed Only', 160, async (id) => observation(id, await user(), true, '2026-07-14T20:00:00Z')); // a check-in is not a schedule
      await add('Low Confidence', 200, (id) => scheduleFact(id, DAILY_10_TO_23, { confidence: 0.4 }));
      await add('Broken Hours', 240, (id) => scheduleFact(id, { v: 1 }, { confidence: 0.9 }));
      await add('Partial Hours', 280, (id) => scheduleFact(id, { ...DAILY_10_TO_23, partial: 'restrictive' })); // open? cannot say
      await add('Kitchen Only', 320, (id) => scheduleFact(id, DAILY_10_TO_23, { service: 'kitchen' }));
    });

    const ALL = ['Open Now', 'Always Open', 'Closed Now', 'No Hours', 'Confirmed Only', 'Low Confidence', 'Broken Hours', 'Partial Hours', 'Kitchen Only'];

    it('on, in the evening: only places whose regular schedule says open now are offered', async () => {
      const spy = jest.spyOn(pool, 'query');
      try {
        const r = await service(true).today(await user(), at.lat, at.lng, RADIUS, false, EVENING);
        expect(names(r, byId)).toEqual(['Always Open', 'Open Now']);
        const scheduleLoads = spy.mock.calls.filter(([sql]) => /service = 'regular'/.test(String(sql)));
        expect(scheduleLoads).toHaveLength(1); // one query, for the candidates
      } finally {
        spy.mockRestore();
      }
    });

    it('on, in the evening: the same place is no longer offered once its schedule says closed (Wednesday 23:30, after closing)', async () => {
      const lateNight = new Date('2026-07-16T03:30:00Z'); // Wednesday 23:30 EDT: after 23:00
      const r = await service(true).today(await user(), at.lat, at.lng, RADIUS, false, lateNight);
      expect(names(r, byId)).toEqual(['Always Open']);
    });

    it('on, in the daytime: everything is offered, and the hours are not even looked up', async () => {
      const spy = jest.spyOn(pool, 'query');
      try {
        const r = await service(true).today(await user(), at.lat, at.lng, RADIUS, false, NOW);
        expect(names(r, byId)).toEqual([...ALL].sort());
        expect(spy.mock.calls.filter(([sql]) => /service = 'regular'/.test(String(sql)))).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('off, in the evening: everything is offered', async () => {
      const r = await service(false).today(await user(), at.lat, at.lng, RADIUS, false, EVENING);
      expect(names(r, byId)).toEqual([...ALL].sort());
    });

    it('the daytime closing time of a place does not keep it from being the day\'s quest', async () => {
      const r = await service(true).today(await user(), at.lat, at.lng, RADIUS, false, new Date('2026-07-15T09:00:00Z')); // 05:00 EDT: the evening window
      expect(names(r, byId)).toEqual(['Always Open']); // 05:00: Open Now opens at 10:00
      const day = await service(true).today(await user(), at.lat, at.lng, RADIUS, false, new Date('2026-07-15T10:00:00Z')); // 06:00 EDT: window over
      expect(names(day, byId)).toEqual([...ALL].sort());
    });

    it('a quest the user already holds is kept when its place would not pass now', async () => {
      const u = await user();
      const first = await service(false).today(u, at.lat, at.lng, RADIUS, false, NOW);
      const held = first.quest!;
      const r = await service(true).today(u, at.lat, at.lng, RADIUS, false, EVENING);
      expect(r.quest?.id).toBe(held.id);
      const heldName = byId.get(held.place.id)!;
      const leads = r.deck.map((d) => byId.get(d.place.id)!);
      // The held quest stays whatever it is; the new leads are only open places (other than the held one).
      expect(leads.every((n) => ['Open Now', 'Always Open'].includes(n) && n !== heldName)).toBe(true);
      await owner.query(`UPDATE quests SET status = 'accepted' WHERE id = $1`, [held.id]);
      const again = await service(true).today(u, at.lat, at.lng, RADIUS, false, EVENING);
      expect(again.quest).toMatchObject({ id: held.id, status: 'accepted' });
    });

    it('an open place offered in the evening shows its hours as open', async () => {
      const r = await service(true).today(await user(), at.lat, at.lng, RADIUS, false, EVENING);
      expect(hoursOf(r, open).hours).toMatchObject({ status: 'known', state: 'open', nextChange: { at: '23:00', to: 'closed' } });
    });
  });
});
