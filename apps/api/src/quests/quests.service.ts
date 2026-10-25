import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { CacheService } from '../cache/cache.service';
import { PG } from '../db/db.module';
import { enqueueQuestEvent } from '../events/outbox';
import { QuestAction as EventAction, SkipReason as EventSkipReason } from '../gen/larper/events/v1/events_pb';
import { TagsService } from '../profile/tags.service';
import { AreasService } from './areas.service';
import { attemptParams, CheckInAttempt, checkInLogLine, judgeCheckIn, RECORD_ATTEMPT_SQL, rejection } from './checkin';
import { cellOf, cellsCovering, haversineM } from './geo';
import { AreaStats, Candidate, mmr, Reasons, score, Scored, weightsFromEnv } from './scoring';
import { QuestAction, QuestStatus, REOFFER_AFTER_DAYS, SkipReason, TRANSITIONS } from './transitions';

const DECK_SIZE = 10;
const CACHED_TOP_N = 200; // enough headroom to survive exclusions + MMR
const MAX_CANDIDATES = 3000;
const DECK_TTL_S = 600;
const AREA_TTL_S = 3600;
const OFFER_STALE_AFTER = '20 hours';
const OFFER_STALE_METERS = 5000;
const PRUNE_ATTEMPTS_EVERY_MS = 6 * 3600_000; // retention is 90 days; this only bounds the overshoot

const EVENT_ACTION: Record<QuestAction, EventAction> = {
  accept: EventAction.ACCEPTED,
  skip: EventAction.SKIPPED,
  'not-today': EventAction.NOT_TODAY,
  complete: EventAction.COMPLETED,
};

// For messages: "cannot set aside a quest that is offered".
const VERB: Record<QuestAction, string> = { accept: 'accept', skip: 'skip', 'not-today': 'set aside', complete: 'complete' };

const EVENT_SKIP_REASON: Record<SkipReason, EventSkipReason> = {
  not_my_thing: EventSkipReason.NOT_MY_THING,
  too_far: EventSkipReason.TOO_FAR,
  not_today: EventSkipReason.NOT_TODAY,
  closed: EventSkipReason.CLOSED,
};

export interface CheckInPosition {
  lat: number;
  lng: number;
  accuracyM?: number;
}

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
export class QuestsService implements OnModuleInit, OnModuleDestroy {
  private readonly weights = weightsFromEnv();

  private readonly logger = new Logger(QuestsService.name);

  constructor(
    @Inject(PG) private readonly pg: Pool,
    private readonly cache: CacheService,
    private readonly tags: TagsService,
    private readonly areas: AreasService,
  ) {}

  async today(userId: string, lat: number, lng: number, radiusM: number) {
    const center = cellOf(lat, lng);
    await this.expireStaleOffer(userId, lat, lng);

    // Unseen areas get an ingest job. Until they land, the deck is partial: rank
    // without caching (a cached partial deck would hide the new places for its whole
    // TTL) and hold off on offering a quest (a better spot may be on its way).
    const survey = await this.areas.survey(lat, lng, radiusM);
    const surveyed = survey.pending.length === 0;

    const taste = await this.loadTaste(userId);
    const rank = () => this.rank(userId, taste.vec, center.lat, center.lng, center.cell, radiusM, surveyed);
    const { value: ranked, hit } = surveyed
      ? await this.cache.getOrSet(`deck:v3:${userId}:${taste.version}:${center.cell}:${radiusM}`, DECK_TTL_S, rank)
      : { value: await rank(), hit: false };

    const excluded = await this.recentlyDone(userId);
    const deck = mmr(
      ranked.filter((p) => !excluded.has(p.id)),
      DECK_SIZE,
    );

    let quest = await this.active(userId, lat, lng);
    if (!quest && deck.length && surveyed) quest = await this.offer(userId, deck[0], lat, lng);

    return {
      quest,
      deck: deck
        .filter((p) => p.id !== quest?.place.id)
        .slice(0, DECK_SIZE - 1)
        .map((p) => ({ score: p.score, reasons: p.reasons, place: toPlaceView(p, lat, lng) })),
      cache: hit ? 'hit' : 'miss',
      surveying: survey.pending.length || survey.failed.length || survey.outside.length ? survey : null,
    };
  }

  // Moves a quest through its state machine and records the event, atomically:
  // the UPDATE and the outbox INSERT share one transaction (see events/outbox.ts).
  async act(userId: string, questId: string, action: QuestAction, at?: CheckInPosition, demo = false) {
    const t = TRANSITIONS[action];
    // Every check-in attempt is logged and stored once with how it ended (see checkin.ts).
    const checkIn: CheckInAttempt | undefined =
      action === 'complete' ? { questId, userId, outcome: 'error', demo } : undefined;
    const tx = await this.pg.connect();
    try {
      await tx.query('BEGIN');
      if (checkIn) await this.checkGeofence(tx, checkIn, at);

      // "Not today" leaves the reason 'unstated' until the user gives one (giveReason).
      const { rows } = await tx.query<{ status: QuestStatus; placeId: string }>(
        `UPDATE quests SET status = $4, updated_at = now(), skip_reason = coalesce($5::skip_reason, skip_reason)
         WHERE id = $1 AND user_id = $2 AND status = ANY($3::quest_status[])
         RETURNING status, place_id::text AS "placeId"`,
        [questId, userId, t.from, t.to, action === 'not-today' ? 'unstated' : null],
      );
      if (!rows.length) {
        const cur = await tx.query<{ status: QuestStatus }>(
          'SELECT status FROM quests WHERE id = $1 AND user_id = $2',
          [questId, userId],
        );
        if (!cur.rows.length) {
          if (checkIn) checkIn.outcome = 'not_found';
          throw new NotFoundException('no such quest');
        }
        if (checkIn) checkIn.outcome = 'conflict';
        throw new ConflictException(`cannot ${VERB[action]} a quest that is ${cur.rows[0].status}`);
      }

      await enqueueQuestEvent(tx, { userId, questId, placeId: rows[0].placeId, action: EVENT_ACTION[action] });
      await tx.query('COMMIT');
      // A simulated demo check-in keeps the geofence's own outcome on record.
      if (checkIn && !checkIn.simulated) checkIn.outcome = 'accepted';
      return {
        id: questId,
        status: rows[0].status,
        ...(checkIn?.simulated ? { simulated: true as const, distanceM: Math.round(checkIn.geofence!.distanceM) } : {}),
      };
    } catch (err) {
      await tx.query('ROLLBACK');
      throw err;
    } finally {
      tx.release();
      if (checkIn) {
        this.logger.log(checkInLogLine(checkIn));
        await this.recordAttempt(checkIn);
      }
    }
  }

  // Outside the action's transaction: a rejected check-in rolls that back, and its
  // attempt is the one we most want. Best effort: a failure here never changes the
  // answer the user gets (the log line above still has it).
  private async recordAttempt(a: CheckInAttempt) {
    try {
      await this.pg.query(RECORD_ATTEMPT_SQL, attemptParams(a));
    } catch (err) {
      this.logger.warn(`checkin attempt not recorded: ${(err as Error).message}`);
    }
  }

  // Check-in attempts older than 90 days go (migration 0014's prune_checkin_attempts),
  // on start and every few hours, so rows don't outlive the retention while it's quiet.
  private pruneTimer?: NodeJS.Timeout;
  onModuleInit() {
    const prune = () =>
      Promise.resolve()
        .then(() => this.pg.query<{ n: string }>('SELECT prune_checkin_attempts() AS n'))
        .then(({ rows }) => {
          if (Number(rows[0]?.n) > 0) this.logger.log(`pruned ${rows[0].n} check-in attempts past 90 days`);
        })
        .catch((err: Error) => this.logger.warn(`check-in attempt pruning failed: ${err.message}`));
    void prune();
    this.pruneTimer = setInterval(() => void prune(), PRUNE_ATTEMPTS_EVERY_MS);
    this.pruneTimer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.pruneTimer);
  }

  // After "Not today": the one reason the user gives, if any. "Not my thing" is a real
  // skip (a SKIPPED event, which taste-worker turns into the usual penalty); the other
  // reasons are only recorded. Either way the event carries the reason.
  async giveReason(userId: string, questId: string, reason: SkipReason) {
    const tx = await this.pg.connect();
    try {
      await tx.query('BEGIN');
      const { rows } = await tx.query<{ placeId: string }>(
        `UPDATE quests SET skip_reason = $3
         WHERE id = $1 AND user_id = $2 AND status = 'skipped' AND skip_reason = 'unstated'
         RETURNING place_id::text AS "placeId"`,
        [questId, userId, reason],
      );
      if (!rows.length) {
        const cur = await tx.query<{ status: QuestStatus; reason: string | null }>(
          'SELECT status, skip_reason AS reason FROM quests WHERE id = $1 AND user_id = $2',
          [questId, userId],
        );
        if (!cur.rows.length) throw new NotFoundException('no such quest');
        const { status, reason: had } = cur.rows[0];
        throw new ConflictException(
          status !== 'skipped' || had === null
            ? 'only a quest set aside with Not today takes a reason'
            : 'this quest already has a reason',
        );
      }
      await enqueueQuestEvent(tx, {
        userId,
        questId,
        placeId: rows[0].placeId,
        action: reason === 'not_my_thing' ? EventAction.SKIPPED : EventAction.NOT_TODAY,
        skipReason: EVENT_SKIP_REASON[reason],
      });
      await tx.query('COMMIT');
      return { id: questId, status: 'skipped' as const, reason };
    } catch (err) {
      await tx.query('ROLLBACK');
      throw err;
    } finally {
      tx.release();
    }
  }

  // A check-in counts only near the place (the rule and its messages: checkin.ts).
  private async checkGeofence(tx: PoolClient, attempt: CheckInAttempt, at?: CheckInPosition) {
    const { userId, questId } = attempt;
    if (!at) {
      attempt.outcome = 'no_position';
      throw new BadRequestException('completing a quest needs your position (lat, lng)');
    }
    const { rows } = await tx.query<{ d: number }>(
      `SELECT ST_Distance(p.geom, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography)::float8 AS d
       FROM quests q JOIN places p ON p.id = q.place_id
       WHERE q.id = $1 AND q.user_id = $2`,
      [questId, userId, at.lng, at.lat],
    );
    if (!rows.length) {
      attempt.outcome = 'not_found';
      throw new NotFoundException('no such quest');
    }
    const geofence = judgeCheckIn(rows[0].d, at.accuracyM);
    attempt.geofence = geofence;
    if (geofence.outcome !== 'accepted') {
      attempt.outcome = geofence.outcome;
      // The shared demo account "arrives" anyway: its visitors are mostly far from the
      // demo area, and a check-in that can never work is the demo's worst moment. The
      // quest completes as a simulated check-in (the web app says so); the attempt keeps
      // the geofence's outcome and the demo flag, so the check-in figures leave it out.
      if (attempt.demo) {
        attempt.simulated = true;
        return;
      }
      throw new UnprocessableEntityException(rejection(geofence));
    }
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
    cacheAreaStats: boolean,
  ): Promise<Scored[]> {
    await this.tags.ready();
    const [area, candidates] = await Promise.all([
      this.areaStats(cell, lat, lng, radiusM, cacheAreaStats),
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
  private async areaStats(
    cell: string,
    lat: number,
    lng: number,
    radiusM: number,
    useCache: boolean,
  ): Promise<AreaStats> {
    const compute = async (): Promise<AreaStats> => {
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
    };
    if (!useCache) return compute();
    return (await this.cache.getOrSet(`area:v1:${cell}:${radiusM}`, AREA_TTL_S, compute)).value;
  }

  // Places in the radius (GiST index), with taste similarity computed by pgvector
  // (<=> is cosine distance) against the user's stored vector. Two steps: rank on the
  // narrow columns, then fetch names, tags, links, distance and chain size for the
  // winners only. A dense cell has ~10k places in the radius, and doing that work for
  // all of them was a third of the query (loadtest/rank-bench.sh).
  // Ties are broken by id: in dense cells thousands of places share the lowest taste
  // (no tags in common), the limit cuts through them, and without a tiebreak which
  // ones made it depended on the plan, so the same request could get another deck.
  private async candidates(userId: string, lat: number, lng: number, radiusM: number): Promise<Candidate[]> {
    const { rows } = await this.pg.query<Candidate>(
      `WITH o AS (SELECT ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography AS g),
       top AS (
         SELECT p.id, coalesce(1 - (p.tag_vec <=> t.vec), 0)::float8 AS taste
         FROM places p
         CROSS JOIN o
         LEFT JOIN taste_profiles t ON t.user_id = $1
         WHERE ST_DWithin(p.geom, o.g, $4)
           AND p.location_suspect IS NULL -- its address says it's elsewhere (migration 0015)
         ORDER BY taste DESC, p.id
         LIMIT ${MAX_CANDIDATES}
       )
       SELECT p.id::text, p.name,
              ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lng,
              p.categories[array_length(p.categories, 1)] AS category, p.tags,
              top.taste,
              p.chain_locations AS "chainLocations",
              p.confidence::float8 AS confidence,
              ST_Distance(p.geom, o.g)::float8 AS "distanceM",
              p.website, p.instagram, p.phone
       FROM top
       JOIN places p ON p.id = top.id
       CROSS JOIN o
       ORDER BY top.taste DESC, top.id`,
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

  // Places not to re-offer yet: each finished quest keeps its place out for the window
  // of how it ended (REOFFER_AFTER_DAYS), counted from when it ended (updated_at; a
  // reason given later doesn't restart it). The longest window bounds the index scan.
  // A key missing from the map gets the longest window, never none.
  private async recentlyDone(userId: string): Promise<Set<string>> {
    const longest = Math.max(...Object.values(REOFFER_AFTER_DAYS));
    const { rows } = await this.pg.query<{ place_id: string }>(
      `SELECT place_id::text FROM quests
       WHERE user_id = $1 AND status IN ('skipped', 'completed')
         AND updated_at > now() - make_interval(days => $3)
         AND updated_at > now() - make_interval(days => coalesce(
               ($2::jsonb ->> CASE WHEN status = 'completed' THEN 'completed'
                                   ELSE coalesce(skip_reason::text, 'skip') END)::int,
               $3))`,
      [userId, JSON.stringify(REOFFER_AFTER_DAYS), longest],
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
    // Whether we inserted or lost a race to another replica, the active row is the
    // answer. It can still be missing: a concurrent request from far away may expire
    // the winner's offer between our INSERT and SELECT. Then the slot is free again,
    // so try again (found by the k6 load test: 2.7% of requests failed here).
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.pg.query(
        `INSERT INTO quests (user_id, place_id, score, reasons, origin)
         VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography)
         ON CONFLICT (user_id) WHERE status IN ('offered', 'accepted') DO NOTHING`,
        [userId, pick.id, pick.score, JSON.stringify(pick.reasons), lng, lat],
      );
      const quest = await this.active(userId, lat, lng);
      if (quest) return quest;
    }
    throw new Error('offer vanished');
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
