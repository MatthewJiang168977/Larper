import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { CacheService } from '../cache/cache.service';
import { PG } from '../db/db.module';
import { TagsService } from '../profile/tags.service';
import { cellOf, cellsCovering, haversineM } from './geo';
import { AreaStats, Candidate, mmr, Reasons, score, Scored, weightsFromEnv } from './scoring';
import { QuestAction, QuestStatus, TRANSITIONS } from './transitions';

const DECK_SIZE = 10;
const CACHED_TOP_N = 200; // enough headroom to survive exclusions + MMR
const MAX_CANDIDATES = 3000;
const DECK_TTL_S = 600;
const AREA_TTL_S = 3600;
const EXCLUDE_DAYS = 30; // don't re-offer a place skipped/completed this recently
const OFFER_STALE_AFTER = '20 hours';
const OFFER_STALE_METERS = 5000;

export interface PlaceView {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
  tags: string[];
  distanceM: number;
  website: string | null;
  instagram: string | null;
  phone: string | null;
}

export interface QuestView {
  id: string;
  status: QuestStatus;
  score: number;
  reasons: Reasons;
  createdAt: string;
  place: PlaceView;
}

export interface DeckItem {
  score: number;
  reasons: Reasons;
  place: PlaceView;
}

@Injectable()
export class QuestsService {
  private readonly weights = weightsFromEnv();

  constructor(
    @Inject(PG) private readonly pg: Pool,
    private readonly cache: CacheService,
    private readonly tags: TagsService,
  ) {}

  async today(userId: string, lat: number, lng: number, radiusM: number) {
    const center = cellOf(lat, lng);
    await this.expireStaleOffer(userId, lat, lng);

    const taste = await this.loadTaste(userId);
    const deckKey = `deck:v3:${userId}:${taste.version}:${center.cell}:${radiusM}`;
    const { value: ranked, hit } = await this.cache.getOrSet(deckKey, DECK_TTL_S, () =>
      this.rank(userId, taste.vec, center.lat, center.lng, center.cell, radiusM),
    );

    const excluded = await this.recentlyDone(userId);
    const deck = mmr(
      ranked.filter((p) => !excluded.has(p.id)),
      DECK_SIZE,
    );

    let quest = await this.active(userId, lat, lng);
    if (!quest && deck.length) quest = await this.offer(userId, deck[0], lat, lng);

    return {
      quest,
      deck: deck
        .filter((p) => p.id !== quest?.place.id)
        .slice(0, DECK_SIZE - 1)
        .map((p) => ({ score: p.score, reasons: p.reasons, place: toPlaceView(p, lat, lng) })),
      cache: hit ? 'hit' : 'miss',
    };
  }

  async act(userId: string, questId: string, action: QuestAction) {
    const t = TRANSITIONS[action];
    const { rows } = await this.pg.query<{ status: QuestStatus }>(
      `UPDATE quests SET status = $4, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status = ANY($3::quest_status[])
       RETURNING status`,
      [questId, userId, t.from, t.to],
    );
    if (rows.length) return { id: questId, status: rows[0].status };

    const cur = await this.pg.query<{ status: QuestStatus }>(
      'SELECT status FROM quests WHERE id = $1 AND user_id = $2',
      [questId, userId],
    );
    if (!cur.rows.length) throw new NotFoundException('no such quest');
    throw new ConflictException(`cannot ${action} a quest that is ${cur.rows[0].status}`);
  }

  // The journal: everything offered to this user, newest first.
  async log(userId: string) {
    const { rows } = await this.pg.query(
      `SELECT q.id::text, q.status, q.created_at AS "createdAt", q.updated_at AS "updatedAt",
              p.name, p.categories[array_length(p.categories, 1)] AS category, q.reasons
       FROM quests q JOIN places p ON p.id = q.place_id
       WHERE q.user_id = $1 AND q.status <> 'expired'
       ORDER BY q.created_at DESC LIMIT 50`,
      [userId],
    );
    return rows;
  }

  // --- ranking ---------------------------------------------------------------

  private async rank(
    userId: string,
    userVec: number[] | null,
    lat: number,
    lng: number,
    cell: string,
    radiusM: number,
  ): Promise<Scored[]> {
    await this.tags.ready();
    const [area, candidates] = await Promise.all([
      this.areaStats(cell, lat, lng, radiusM),
      this.candidates(userId, lat, lng, radiusM),
    ]);
    const weightOf = (tag: string) => {
      const slot = this.tags.slotOf(tag);
      return userVec && slot !== undefined ? userVec[slot] : 0;
    };
    // A great match at the edge of the radius keeps ~37% of its score: worth the walk.
    const ctx = { bestTaste: Math.max(0, ...candidates.map((c) => c.taste)), d0: radiusM };
    return candidates
      .map((c) => score(c, area, weightOf, ctx, this.weights))
      .sort((a, b) => b.score - a.score)
      .slice(0, CACHED_TOP_N);
  }

  // Shared by every user in the cell, so cached separately from the per-user deck.
  private async areaStats(cell: string, lat: number, lng: number, radiusM: number): Promise<AreaStats> {
    const { value } = await this.cache.getOrSet(`area:v1:${cell}:${radiusM}`, AREA_TTL_S, async () => {
      const cells = cellsCovering(lat, lng, radiusM);
      const [total, counts] = await Promise.all([
        this.pg.query<{ total: number }>(
          'SELECT coalesce(sum(places), 0)::int AS total FROM area_totals WHERE geohash6 = ANY($1)',
          [cells],
        ),
        this.pg.query<{ tag: string; n: number }>(
          'SELECT tag, sum(count)::int AS n FROM area_stats WHERE geohash6 = ANY($1) GROUP BY tag',
          [cells],
        ),
      ]);
      return {
        total: total.rows[0].total,
        tagCounts: Object.fromEntries(counts.rows.map((r) => [r.tag, r.n])),
      };
    });
    return value;
  }

  // Places in the radius (GiST index), with taste similarity computed by pgvector
  // (<=> is cosine distance) against the user's stored vector.
  private async candidates(userId: string, lat: number, lng: number, radiusM: number): Promise<Candidate[]> {
    const { rows } = await this.pg.query<Candidate>(
      `WITH o AS (SELECT ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography AS g)
       SELECT p.id::text, p.name,
              ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lng,
              p.categories[array_length(p.categories, 1)] AS category, p.tags,
              coalesce(1 - (p.tag_vec <=> t.vec), 0)::float8 AS taste,
              coalesce(c.locations, 1) AS "chainLocations",
              p.confidence::float8 AS confidence,
              ST_Distance(p.geom, o.g)::float8 AS "distanceM",
              p.website, p.instagram, p.phone
       FROM places p
       CROSS JOIN o
       LEFT JOIN taste_profiles t ON t.user_id = $1
       LEFT JOIN chain_stats c ON c.chain_key = p.chain_key
       WHERE ST_DWithin(p.geom, o.g, $4)
       ORDER BY taste DESC
       LIMIT ${MAX_CANDIDATES}`,
      [userId, lng, lat, radiusM],
    );
    return rows;
  }

  private async loadTaste(userId: string): Promise<{ vec: number[] | null; version: string }> {
    const { rows } = await this.pg.query<{ vec: string; version: string }>(
      `SELECT vec::text AS vec, (extract(epoch FROM updated_at) * 1000)::bigint::text AS version
       FROM taste_profiles WHERE user_id = $1`,
      [userId],
    );
    if (!rows.length) return { vec: null, version: 'none' };
    return { vec: JSON.parse(rows[0].vec) as number[], version: rows[0].version };
  }

  // --- quest lifecycle -------------------------------------------------------

  private async recentlyDone(userId: string): Promise<Set<string>> {
    const { rows } = await this.pg.query<{ place_id: string }>(
      `SELECT place_id::text FROM quests
       WHERE user_id = $1 AND status IN ('skipped', 'completed')
         AND updated_at > now() - make_interval(days => $2)`,
      [userId, EXCLUDE_DAYS],
    );
    return new Set(rows.map((r) => r.place_id));
  }

  // An offer goes stale if it's old or the user is now far from where it was made.
  // Accepted quests never expire on their own: the user committed to them.
  private async expireStaleOffer(userId: string, lat: number, lng: number) {
    await this.pg.query(
      `UPDATE quests SET status = 'expired', updated_at = now()
       WHERE user_id = $1 AND status = 'offered'
         AND (created_at < now() - $4::interval
              OR NOT ST_DWithin(origin, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $5))`,
      [userId, lng, lat, OFFER_STALE_AFTER, OFFER_STALE_METERS],
    );
  }

  private async active(userId: string, lat: number, lng: number): Promise<QuestView | null> {
    const { rows } = await this.pg.query<QuestRow>(
      `${QUEST_SELECT} WHERE q.user_id = $1 AND q.status IN ('offered', 'accepted')`,
      [userId],
    );
    return rows.length ? toQuestView(rows[0], lat, lng) : null;
  }

  private async offer(userId: string, pick: Scored, lat: number, lng: number): Promise<QuestView> {
    await this.pg.query(
      `INSERT INTO quests (user_id, place_id, score, reasons, origin)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography)
       ON CONFLICT (user_id) WHERE status IN ('offered', 'accepted') DO NOTHING`,
      [userId, pick.id, pick.score, JSON.stringify(pick.reasons), lng, lat],
    );
    // Whether we inserted or lost a race to another replica, the active row is the answer.
    const quest = await this.active(userId, lat, lng);
    if (!quest) throw new Error('offer vanished');
    return quest;
  }
}

const QUEST_SELECT = `
  SELECT q.id::text, q.status, q.score::float8 AS score, q.reasons, q.created_at AS "createdAt",
         p.id::text AS "placeId", p.name, ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lng,
         p.categories[array_length(p.categories, 1)] AS category, p.tags,
         p.website, p.instagram, p.phone
  FROM quests q JOIN places p ON p.id = q.place_id`;

interface QuestRow {
  id: string;
  status: QuestStatus;
  score: number;
  reasons: Reasons;
  createdAt: Date;
  placeId: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
  tags: string[];
  website: string | null;
  instagram: string | null;
  phone: string | null;
}

function toQuestView(r: QuestRow, lat: number, lng: number): QuestView {
  return {
    id: r.id,
    status: r.status,
    score: r.score,
    reasons: r.reasons,
    createdAt: r.createdAt.toISOString(),
    place: toPlaceView({ ...r, id: r.placeId }, lat, lng),
  };
}

// Distances in the cached deck are from the cell center; report them from the user.
function toPlaceView(
  p: Omit<PlaceView, 'distanceM'>,
  lat: number,
  lng: number,
): PlaceView {
  return {
    id: p.id,
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    category: p.category,
    tags: p.tags,
    distanceM: Math.round(haversineM(lat, lng, p.lat, p.lng)),
    website: p.website,
    instagram: p.instagram,
    phone: p.phone,
  };
}
