import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import type { CacheService } from '../cache/cache.service';
import { createPool } from '../db/db.module';
import { assertDisposableDatabase } from '../db/test-guard';
import { loadPlaceHours, loadRegularSchedules } from '../hours/place-hours';
import type { TagsService } from '../profile/tags.service';
import type { AreasService } from '../quests/areas.service';
import { QuestsService } from '../quests/quests.service';
import { CurationService } from './curation.service';
import { loadInsiderNotes, loadRejected } from './place-facts';

// The curator's facts against a real database (migration 0023), as the API's role; fixtures
// and cleanup as the owner. Places sit in the South Atlantic, away from every other spec.
const URL = process.env.TEST_DATABASE_URL;
const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? URL;
const describeDb = URL ? describe : describe.skip;
const NOW = new Date();
const DAY_MS = 86_400_000;

describeDb('curation facts (real database)', () => {
  let pool: Pool;
  let owner: Pool;
  let curation: CurationService;
  let admin: string;
  const placeIds: string[] = [];
  const userIds: string[] = [];
  let areaN = 0;
  const spot = () => ({ lat: -41 - 0.1 * ++areaN, lng: -20 });

  const place = async (at: { lat: number; lng: number }, name: string) => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
       VALUES ('test-curation-' || gen_random_uuid(), $1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
               '{food_and_drink,cafe}', 'test-curation-' || gen_random_uuid(), '{cafe}', array_fill(0, ARRAY[160])::vector, 0.9)
       RETURNING id::text`,
      [name, at.lng, at.lat],
    );
    placeIds.push(rows[0].id);
    return rows[0].id;
  };
  const user = async () => {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO users (clerk_id) VALUES ('test_curation_' || gen_random_uuid()) RETURNING id::text`,
    );
    userIds.push(rows[0].id);
    return rows[0].id;
  };

  beforeAll(async () => {
    pool = createPool(URL);
    owner = createPool(OWNER_URL);
    await assertDisposableDatabase(owner, 'curation.db.spec');
    curation = new CurationService(pool);
    admin = await user();
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

  it('stores who, when and the source, and the latest verdict stands', async () => {
    const id = await place(spot(), 'Verdict Spot');
    await curation.record(admin, id, { kind: 'closed' });
    expect([...(await loadRejected(pool, [id]))]).toEqual([id]);
    const after = await curation.record(admin, id, { kind: 'great' });
    expect(after.verdict).toMatchObject({ kind: 'great', expired: false });
    expect(await loadRejected(pool, [id])).toEqual(new Set());
    const { rows } = await owner.query(
      'SELECT source, user_id::text AS "userId", created_at FROM place_facts WHERE place_id = $1',
      [id],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ source: 'hand-verified', userId: admin });
      expect(r.created_at).toBeInstanceOf(Date);
    }
  });

  it('keeps one note, clears it with an empty one, and refuses a long or two-line note', async () => {
    const id = await place(spot(), 'Note Spot');
    await curation.record(admin, id, { kind: 'note', note: '  ask for the back room  ' });
    expect((await loadInsiderNotes(pool, [id])).get(id)).toMatchObject({ text: 'ask for the back room', source: 'hand-verified' });
    expect((await curation.record(admin, id, { kind: 'note', note: '😀'.repeat(140) })).note?.text).toBe('😀'.repeat(140));
    for (const note of ['x'.repeat(141), 'one\ntwo', undefined]) {
      await expect(curation.record(admin, id, { kind: 'note', note })).rejects.toThrow(BadRequestException);
    }
    expect((await curation.record(admin, id, { kind: 'note', note: '' })).note).toBeNull();
    expect(await loadInsiderNotes(pool, [id])).toEqual(new Map());
  });

  it('serves hand-verified hours, expires them after 90 days, and clears them', async () => {
    const id = await place(spot(), 'Hours Spot');
    await owner.query(
      `INSERT INTO place_hours_facts (place_id, kind, source, fetched_at, confidence, schedule, raw)
       VALUES ($1, 'schedule', 'manual', now() - interval '10 days', 0.9, $2::jsonb, 'Mo-Su 09:00-10:00')`,
      [id, JSON.stringify({ v: 1, tz: 'America/New_York', always: false, weekly: [{ d: 1, from: 540, to: 600 }], dates: [], holidays: null, partial: 'none' })],
    );
    await curation.record(admin, id, { kind: 'hours', hours: '24/7' });
    const hours = (await loadPlaceHours(pool, [id], NOW)).get(id)!.hours;
    expect(hours).toMatchObject({ status: 'known', state: 'open', source: 'hand-verified' });
    expect((await loadRegularSchedules(pool, [id], NOW)).get(id)?.always).toBe(true);

    // 91 days on, neither the curator's nor the older import's hours are used.
    const later = new Date(NOW.getTime() + 91 * DAY_MS);
    expect((await loadPlaceHours(pool, [id], later)).get(id)!.hours).toEqual({ status: 'unverified' });
    expect(await loadRegularSchedules(pool, [id], later)).toEqual(new Map());

    // Clearing masks the older import too.
    await curation.record(admin, id, { kind: 'hours', hours: '' });
    expect((await loadPlaceHours(pool, [id], NOW)).get(id)!.hours).toEqual({ status: 'unverified' });

    await expect(curation.record(admin, id, { kind: 'hours', hours: '9am to 5pm' })).rejects.toThrow(BadRequestException);
  });

  it('refuses an unknown place or kind', async () => {
    await expect(curation.record(admin, '999999999999', { kind: 'verified' })).rejects.toThrow(NotFoundException);
    const id = await place(spot(), 'Kind Spot');
    await expect(curation.record(admin, id, { kind: 'amazing' })).rejects.toThrow(BadRequestException);
  });

  it('shows reports by day and kind, never who', async () => {
    const id = await place(spot(), 'Report Spot');
    const visitor = await user();
    await owner.query(
      `INSERT INTO place_hours_facts (place_id, kind, source, fetched_at, confidence, was_open, user_id)
       VALUES ($1, 'observation', 'check-in', '2026-07-15T22:00:00Z', 0.9, false, $2)`,
      [id, visitor],
    );
    const facts = (await curation.facts([id])).get(id)!;
    expect(facts.reports).toEqual([{ kind: 'wasnt_open', day: '2026-07-15' }]);
  });

  it('stops offering a rejected place at once, and carries the note on the quest', async () => {
    const at = spot();
    const bad = await place(at, 'Bad Fit Spot');
    const good = await place({ lat: at.lat + 0.0005, lng: at.lng }, 'Good Spot');
    const cached = new Map<string, unknown>();
    const cache = {
      getOrSet: async (k: string, _t: number, fn: () => Promise<unknown>) => {
        const hit = cached.has(k);
        if (!hit) cached.set(k, await fn());
        return { value: cached.get(k), hit };
      },
    };
    const quests = new QuestsService(
      pool,
      cache as unknown as CacheService,
      { ready: async () => undefined, slotOf: () => undefined } as unknown as TagsService,
      { survey: async () => ({ pending: [], failed: [], outside: [] }) } as unknown as AreasService,
    );
    const visitor = await user();
    const first = await quests.today(visitor, at.lat, at.lng, 1500, true);
    expect([first.quest!.place.id, ...first.deck.map((d) => d.place.id)].sort()).toEqual([bad, good].sort());

    await curation.record(admin, bad, { kind: 'bad_fit' });
    await curation.record(admin, good, { kind: 'note', note: 'go at dusk' });
    const second = await quests.today(await user(), at.lat, at.lng, 1500);
    expect(second.quest!.place.id).toBe(good);
    expect(second.quest!.place.insiderNote?.text).toBe('go at dusk');
    expect(second.deck).toEqual([]);
  });

  it('lists a neighbourhood with its facts', async () => {
    const id = await place({ lat: 40.7265, lng: -73.984 }, 'East Village Test Cafe');
    await curation.record(admin, id, { kind: 'verified' });
    const list = await curation.list('east-village');
    const found = list.places.find((p) => p.id === id);
    expect(found).toMatchObject({ name: 'East Village Test Cafe', address: null, verdict: { kind: 'verified' } });
    await expect(curation.list('midtown')).rejects.toThrow(BadRequestException);
  });

  it("keeps the facts when the curator's account goes, without the user id", async () => {
    const leaving = await user();
    const id = await place(spot(), 'Departing Curator Spot');
    await curation.record(leaving, id, { kind: 'closed' });
    await pool.query('SELECT delete_my_account($1)', [leaving]);
    const { rows } = await owner.query('SELECT kind, user_id FROM place_facts WHERE place_id = $1', [id]);
    expect(rows).toEqual([{ kind: 'closed', user_id: null }]);
  });
});
