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
import { loadInsiderNotes, loadRejected, type InsiderNote } from '../curation/place-facts';
import { PG } from '../db/db.module';
import { enqueuePlaceReport, enqueueQuestEvent } from '../events/outbox';
import { PlaceReportKind, QuestAction as EventAction, SkipReason as EventSkipReason } from '../gen/larper/events/v1/events_pb';
import { watchExcludedPlaces } from '../metrics/metrics';
import { TagsService } from '../profile/tags.service';
import { AreasService } from './areas.service';
import { attemptParams, CheckInAttempt, checkInLogLine, judgeCheckIn, RECORD_ATTEMPT_SQL, rejection } from './checkin';
import { loadPlaceHours, requireObserver, loadRegularSchedules, NO_HOURS, type PlaceHours, type OpenConfirmations } from '../hours/place-hours';
import { type Schedule, stateAt } from '../hours/schedule';
import {
  BLOCKED_CATEGORIES,
  CATEGORY_EXCEPTION_IDS,
  GateConfig,
  gateConfigFromEnv,
  isEveningInNyc,
  passesHoursRule,
} from './eligibility';
import { cellOf, cellsCovering, haversineM } from './geo';
import { applyReliability, loadReliability } from './reliability';
import { DECK_SIZE, MAX_CANDIDATES, rankCandidates } from './ranker';
import { AreaStats, Candidate, mmr, Reasons, Scored, weightsFromEnv } from './scoring';
import { QuestAction, QuestStatus, REOFFER_AFTER_DAYS, SkipReason, TRANSITIONS } from './transitions';

const SAVED_PLACES_LIMIT = 100;
const DECK_TTL_S = 600;
const AREA_TTL_S = 3600;
const OFFER_STALE_AFTER = '20 hours';
const OFFER_STALE_METERS = 5000;
const DAY_TIME_ZONE = 'America/New_York'; // when "today" ends (doneToday); the evening rule's clock too (eligibility.ts)
// Bumped from v3 when the trust gate (eligibility.ts) began filtering before ranking:
// decks cached by older pods hold places the gate now refuses.
const DECK_CACHE_VERSION = 'v6'; // Category exceptions and the liquor-store/shooting-range exclusions.
/** Where a quest was offered is only needed while the offer is open (the stale-offer check). */
export const SCRUB_ORIGINS_SQL = `UPDATE quests SET origin = NULL WHERE origin IS NOT NULL AND status IN ('expired', 'completed', 'skipped')`;
const PRUNE_ATTEMPTS_EVERY_MS = 6 * 3600_000; // retention is 90 days; this only bounds the overshoot

export const EVENT_ACTION: Record<QuestAction, EventAction> = {
  accept: EventAction.ACCEPTED,
  skip: EventAction.SKIPPED,
  'not-today': EventAction.NOT_TODAY,
  complete: EventAction.COMPLETED,
};

// For messages: "cannot set aside a quest that is offered".
const VERB: Record<QuestAction, string> = { accept: 'accept', skip: 'skip', 'not-today': 'set aside', complete: 'complete' };

// The reasons that count as saying "I don't like this place": they re-emit the quest's
// event as SKIPPED, which taste-worker turns into the -0.05 step. Every other reason
// (and "Not today" with no reason) is NOT_TODAY, which moves nothing. Deciding that "Not
// my thing" should stop counting as a dislike is a change to this one list.
export const REASONS_THAT_COUNT_AS_DISLIKE: readonly SkipReason[] = ['not_my_thing'];

/** The event giveReason() emits for a reason: SKIPPED only for a dislike, else NOT_TODAY. */
export const eventActionForReason = (reason: SkipReason): EventAction =>
  REASONS_THAT_COUNT_AS_DISLIKE.includes(reason) ? EventAction.SKIPPED : EventAction.NOT_TODAY;

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
  // Opening hours (migration 0018). 'unverified' = no usable schedule on file, which says nothing
  // about whether the place is open. Never shown as closed.
  hours: PlaceHours;
  // How many different people said it was open when they checked in (last 180 days), and the
  // newest one's day and part of day in New York. No dates, no times, no people.
  openConfirmations: OpenConfirmations | null;
  // The curator's one-line note (place_facts), shown first under "Why this place".
  insiderNote: InsiderNote | null;
}

export interface SavedPlaceView {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category: string;
  savedAt: string;
}

export const WAS_OPEN_ANSWERS = ['yes', 'no', 'didnt_check'] as const;
export type WasOpenAnswer = (typeof WAS_OPEN_ANSWERS)[number];
export const isWasOpenAnswer = (x: unknown): x is WasOpenAnswer =>
  typeof x === 'string' && (WAS_OPEN_ANSWERS as readonly string[]).includes(x);

export const WORTH_IT_ANSWERS = ['yes', 'meh', 'no'] as const;
export type WorthItAnswer = (typeof WORTH_IT_ANSWERS)[number];
export const isWorthItAnswer = (x: unknown): x is WorthItAnswer =>
  typeof x === 'string' && (WORTH_IT_ANSWERS as readonly string[]).includes(x);

const WORTH_IT_ACTION: Record<WorthItAnswer, EventAction> = {
  yes: EventAction.WORTH_IT_YES,
  meh: EventAction.WORTH_IT_MEH,
  no: EventAction.WORTH_IT_NO,
};

export interface QuestView {
  id: string;
  status: QuestStatus;
  score: number;
  reasons: Reasons;
  createdAt: string;
  place: PlaceView;
  // This user's answer to "was it open?" for this quest (null: not asked, or not yet answered).
  wasOpen: WasOpenAnswer | null;
  // This user's answer to "worth it?" (null: not answered).
  worthIt: WorthItAnswer | null;
}

export interface DeckItem {
  score: number;
  reasons: Reasons;
  place: PlaceView;
}

@Injectable()
export class QuestsService implements OnModuleInit, OnModuleDestroy {
  private readonly weights = weightsFromEnv();

  // The trust gate's settings (eligibility.ts). Not readonly: the database specs set it.
  gate: GateConfig = gateConfigFromEnv();

  private readonly logger = new Logger(QuestsService.name);

  constructor(
    @Inject(PG) private readonly pg: Pool,
    private readonly cache: CacheService,
    private readonly tags: TagsService,
    private readonly areas: AreasService,
  ) {}

  async today(userId: string, lat: number, lng: number, radiusM: number, demo = false, now = new Date()) {
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
      ? // The confidence floor is in the key, so changing QUEST_MIN_CONFIDENCE never serves a
        // deck ranked under the old floor. A blocklist change still needs DECK_CACHE_VERSION bumped.
        // It shares the last segment with the radius ("1500c0.7"), never a segment of its own:
        // CacheService.forgetUser matches deck:*:<id>:*, and Redis's * spans colons, so a
        // segment after the radius would let user 1500's delete match everyone's 1500 m decks.
        await this.cache.getOrSet(
          `deck:${DECK_CACHE_VERSION}:${userId}:${taste.version}:${center.cell}:${radiusM}c${this.gate.minConfidence}`,
          DECK_TTL_S,
          rank,
        )
      : { value: await rank(), hit: false };

    // The cached deck already holds only places that pass the gate's static rules (rank).
    // The evening rule depends on the clock, so it is applied here, like the exclusions:
    // an empty deck is the usual empty state, and a quest the user already has stays.
    // Its hours are looked up only when the rule is active (flag on, New York evening), in
    // one query for the candidates that survive the exclusions.
    const excluded = await this.recentlyDone(userId);
    const unseen = ranked.filter((p) => !excluded.has(p.id));
    // The curator's "closed" and "bad fit", applied after the cache like the exclusions, so a
    // tap takes effect on the next request.
    const rejected = await loadRejected(this.pg, unseen.map((p) => p.id));
    // Then what people reported (place_reliability): suspended places go, doubtful ones drop
    // down. Also after the cache, so a report takes effect on the next request.
    const kept = unseen.filter((p) => !rejected.has(p.id));
    const candidates = applyReliability(kept, await loadReliability(this.pg, kept.map((p) => p.id)), now);
    const eveningRule = this.gate.eveningUnknownHours && isEveningInNyc(now);
    const schedules = eveningRule ? await loadRegularSchedules(this.pg, candidates.map((p) => p.id), now) : null;
    const deck = mmr(
      candidates.filter((p) => passesHoursRule(openAt(schedules, p.id, now), now, this.gate.eveningUnknownHours)),
      DECK_SIZE,
    );

    // One quest a day: once checked in, today's page stays on that quest, with no leads,
    // until the day turns over. Not for the demo account: visitors share it, and the
    // first check-in would end the day for everyone after them.
    let quest = await this.active(userId, lat, lng);
    if (!quest && !demo) quest = await this.doneToday(userId, lat, lng);
    if (!quest && deck.length && surveyed) quest = await this.offer(userId, deck[0], lat, lng);
    const done = quest?.status === 'completed';
    const leads = done ? [] : deck.filter((p) => p.id !== quest?.place.id).slice(0, DECK_SIZE - 1);

    // Hours and confirmations for the places in this response (the quest and the leads, at
    // most ten), in one query. The deck cache never holds them: they change with the clock.
    const shown = [...(quest ? [quest.place.id] : []), ...leads.map((p) => p.id)];
    const [hours, notes] = await Promise.all([loadPlaceHours(this.pg, shown, now), loadInsiderNotes(this.pg, shown)]);
    const withHours = (p: PlaceView): PlaceView => ({
      ...p,
      ...(hours.get(p.id) ?? NO_HOURS),
      insiderNote: notes.get(p.id) ?? null,
    });

    return {
      quest: quest ? { ...quest, place: withHours(quest.place) } : quest,
      deck: leads.map((p) => ({ score: p.score, reasons: p.reasons, place: withHours(toPlaceView(p, lat, lng)) })),
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
      await this.lockUserQuest(tx, userId, questId);

      // "Not today" leaves the reason 'unstated' until the user gives one (giveReason).
      // A simulated demo check-in is marked in the quest's reasons, so the journal can
      // say so: a flag there needs no migration (no column, no grant), and old pods
      // leave it alone. accepted_at and completed_at are the quest's facts for the profile
      // stats (migration 0016); a simulated check-in sets completed_at like any other.
      const { rows } = await tx.query<{ status: QuestStatus; placeId: string }>(
        `UPDATE quests SET status = $4::quest_status, updated_at = now(), skip_reason = coalesce($5::skip_reason, skip_reason),
                reasons = CASE WHEN $6 THEN reasons || '{"simulated": true}'::jsonb ELSE reasons END,
                accepted_at = CASE WHEN $4::quest_status = 'accepted' THEN now() ELSE accepted_at END,
                completed_at = CASE WHEN $4::quest_status = 'completed' THEN now() ELSE completed_at END,
                origin = CASE WHEN $4::quest_status IN ('completed', 'skipped') THEN NULL ELSE origin END
         WHERE id = $1 AND user_id = $2 AND status = ANY($3::quest_status[])
         RETURNING status, place_id::text AS "placeId"`,
        [questId, userId, t.from, t.to, action === 'not-today' ? 'unstated' : null, !!checkIn?.simulated],
      );
      if (!rows.length) {
        const cur = await tx.query<{ status: QuestStatus }>(
          'SELECT status FROM quests WHERE id = $1 AND user_id = $2',
          [questId, userId],
        );
        if (!cur.rows.length) throw new NotFoundException('no such quest');
        if (checkIn) checkIn.outcome = 'conflict';
        throw new ConflictException(`cannot ${VERB[action]} a quest that is ${cur.rows[0].status}`);
      }

      // Accepting also puts the place on the user's "want to go" list, in the same
      // transaction. Both ids come from the UPDATE above (this user's own quest), never
      // from the request. Idempotent: a second quest at the same place changes nothing.
      if (action === 'accept') {
        await tx.query(
          `INSERT INTO saved_places (user_id, place_id, quest_id) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, place_id) DO NOTHING`,
          [userId, rows[0].placeId, questId],
        );
      }
      await enqueueQuestEvent(tx, { userId, questId, placeId: rows[0].placeId, action: EVENT_ACTION[action] });
      // A real check-in says the place was there. Not the shared demo account's, nor a
      // simulated one: nobody went.
      if (action === 'complete' && !demo && !checkIn?.simulated) {
        await enqueuePlaceReport(tx, { userId, questId, placeId: rows[0].placeId, kind: PlaceReportKind.CHECKED_IN });
      }
      await tx.query('COMMIT');
      // A simulated demo check-in keeps the geofence's own outcome on record.
      if (checkIn && !checkIn.simulated) checkIn.outcome = 'accepted';
      return {
        id: questId,
        status: rows[0].status,
        ...(checkIn?.simulated ? { simulated: true as const, distanceM: Math.round(checkIn.geofence!.distanceM) } : {}),
      };
    } catch (err) {
      if (checkIn && err instanceof NotFoundException) checkIn.outcome = 'not_found';
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

  // Lock the user before the quest so history/account deletion can wait before it
  // touches children, even for actions that insert a row with a user FK.
  private async lockUserQuest(tx: PoolClient, userId: string, questId: string) {
    const { rows } = await tx.query<{ present: boolean }>(
      'SELECT lock_user_quest($1, $2) AS present',
      [userId, questId],
    );
    if (!rows[0].present) throw new NotFoundException('no such quest');
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
  // The same sweep drops the exact position (origin) of every quest whose offer is over
  // (migration 0020): the paths that resolve a quest do it themselves, this catches rows
  // from before and anything a path missed.
  private pruneTimer?: NodeJS.Timeout;
  onModuleInit() {
    watchExcludedPlaces(async () => {
      const { rows } = await this.pg.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM place_reliability WHERE suspended_at IS NOT NULL',
      );
      return rows[0].n;
    });
    const prune = () =>
      Promise.resolve()
        .then(() => this.pg.query<{ n: string }>('SELECT prune_checkin_attempts() AS n'))
        .then(({ rows }) => {
          if (Number(rows[0]?.n) > 0) this.logger.log(`pruned ${rows[0].n} check-in attempts past 90 days`);
        })
        .catch((err: Error) => this.logger.warn(`check-in attempt pruning failed: ${err.message}`));
    const scrub = () =>
      Promise.resolve()
        .then(() => this.pg.query(SCRUB_ORIGINS_SQL))
        .then(({ rowCount }) => {
          if (rowCount) this.logger.log(`dropped the offer position of ${rowCount} resolved quests`);
        })
        .catch((err: Error) => this.logger.warn(`offer position scrub failed: ${err.message}`));
    void prune();
    void scrub();
    this.pruneTimer = setInterval(() => {
      void prune();
      void scrub();
    }, PRUNE_ATTEMPTS_EVERY_MS);
    this.pruneTimer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.pruneTimer);
  }

  // After "Not today": the one reason the user gives, if any. "Not my thing" is a real
  // skip (a SKIPPED event, which taste-worker turns into the usual penalty); the other
  // reasons are only recorded. Either way the event carries the reason.
  async giveReason(userId: string, questId: string, reason: SkipReason, demo = false) {
    const tx = await this.pg.connect();
    try {
      await tx.query('BEGIN');
      await this.lockUserQuest(tx, userId, questId);
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
        action: eventActionForReason(reason),
        skipReason: EVENT_SKIP_REASON[reason],
      });
      if (reason === 'closed' && !demo) {
        await enqueuePlaceReport(tx, { userId, questId, placeId: rows[0].placeId, kind: PlaceReportKind.SKIPPED_CLOSED });
      }
      await tx.query('COMMIT');
      return { id: questId, status: 'skipped' as const, reason };
    } catch (err) {
      await tx.query('ROLLBACK');
      throw err;
    } finally {
      tx.release();
    }
  }

  // After a check-in: "was it open?". Stored as a hours fact (source 'check-in', migration 0018),
  // one per quest, and the FIRST answer stands: a repeat call changes nothing and returns it.
  // The place, the user and the time come from the quest row, never from the request. Nobody
  // went on a simulated demo check-in, so it has nothing to say. A first yes or no is also a
  // PlaceReport for the place's reliability score; it moves no taste and no schedule.
  async wasOpen(userId: string, questId: string, answer: WasOpenAnswer): Promise<{ wasOpen: WasOpenAnswer }> {
    requireObserver(userId); // an observation always has a user (also a CHECK in migration 0019)
    const tx = await this.pg.connect();
    try {
      await tx.query('BEGIN');
      await this.lockUserQuest(tx, userId, questId); // user first, then quest: 404 if either is gone
      const { rows } = await tx.query<{ status: QuestStatus; placeId: string; at: Date; simulated: boolean }>(
        `SELECT status, place_id::text AS "placeId", coalesce(completed_at, updated_at) AS at,
                coalesce((reasons->>'simulated')::boolean, false) AS simulated
         FROM quests WHERE id = $1 AND user_id = $2`,
        [questId, userId],
      );
      if (!rows.length) throw new NotFoundException('no such quest');
      const q = rows[0];
      if (q.status !== 'completed') throw new ConflictException('only a quest you checked in at can be asked about');
      if (q.simulated) throw new ConflictException('a simulated check-in has no answer: nobody went');

      const inserted = await tx.query(
        `INSERT INTO place_hours_facts (place_id, kind, source, fetched_at, confidence, was_open, quest_id, user_id)
         VALUES ($1, 'observation', 'check-in', $2, $3::real, $4::boolean, $5, $6)
         ON CONFLICT (quest_id) WHERE quest_id IS NOT NULL DO NOTHING`,
        [q.placeId, q.at, answer === 'didnt_check' ? 0 : 0.9, answer === 'didnt_check' ? null : answer === 'yes', questId, userId],
      );
      if (inserted.rowCount && answer !== 'didnt_check') {
        const kind = answer === 'yes' ? PlaceReportKind.CONFIRMED_OPEN : PlaceReportKind.WASNT_OPEN;
        await enqueuePlaceReport(tx, { userId, questId, placeId: q.placeId, kind, at: q.at });
      }
      const stored = await tx.query<{ wasOpen: boolean | null }>(
        'SELECT was_open AS "wasOpen" FROM place_hours_facts WHERE quest_id = $1 AND user_id = $2',
        [questId, userId],
      );
      await tx.query('COMMIT');
      const w = stored.rows[0]?.wasOpen;
      return { wasOpen: w === true ? 'yes' : w === false ? 'no' : 'didnt_check' };
    } catch (err) {
      await tx.query('ROLLBACK');
      throw err;
    } finally {
      tx.release();
    }
  }

  // After a check-in: "worth it?". Stored on the quest, and the FIRST answer stands, as with
  // "was it open?". It also goes to the taste worker, as a stronger signal than accepting or
  // skipping. updated_at stays: it drives re-offering and "done today".
  async worthIt(userId: string, questId: string, answer: WorthItAnswer): Promise<{ worthIt: WorthItAnswer }> {
    const tx = await this.pg.connect();
    try {
      await tx.query('BEGIN');
      await this.lockUserQuest(tx, userId, questId);
      const { rows } = await tx.query<{ status: QuestStatus; placeId: string; simulated: boolean }>(
        `SELECT status, place_id::text AS "placeId", coalesce((reasons->>'simulated')::boolean, false) AS simulated
         FROM quests WHERE id = $1 AND user_id = $2`,
        [questId, userId],
      );
      if (!rows.length) throw new NotFoundException('no such quest');
      if (rows[0].status !== 'completed') throw new ConflictException('only a quest you checked in at can be asked about');
      if (rows[0].simulated) throw new ConflictException('a simulated check-in has no answer: nobody went');

      const set = await tx.query(
        `UPDATE quests SET worth_it = $3, worth_it_at = now() WHERE id = $1 AND user_id = $2 AND worth_it IS NULL`,
        [questId, userId, answer],
      );
      if (set.rowCount) {
        await enqueueQuestEvent(tx, { userId, questId, placeId: rows[0].placeId, action: WORTH_IT_ACTION[answer] });
      }
      const stored = await tx.query<{ worthIt: WorthItAnswer }>(
        'SELECT worth_it AS "worthIt" FROM quests WHERE id = $1 AND user_id = $2',
        [questId, userId],
      );
      await tx.query('COMMIT');
      return { worthIt: stored.rows[0].worthIt };
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
              p.name, p.categories[array_length(p.categories, 1)] AS category,
              q.reasons - 'simulated' AS reasons, coalesce((q.reasons->>'simulated')::boolean, false) AS simulated
       FROM quests q JOIN places p ON p.id = q.place_id
       WHERE q.user_id = $1 AND q.status <> 'expired'
       ORDER BY q.created_at DESC LIMIT 50`,
      [userId],
    );
    return rows;
  }

  // The "want to go" list: places the user accepted a quest at, newest first.
  async savedPlaces(userId: string): Promise<SavedPlaceView[]> {
    const { rows } = await this.pg.query<SavedPlaceView & { savedAt: Date }>(
      `SELECT p.id::text, p.name, ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lng,
              p.categories[array_length(p.categories, 1)] AS category, s.created_at AS "savedAt"
       FROM saved_places s JOIN places p ON p.id = s.place_id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC, p.id DESC LIMIT ${SAVED_PLACES_LIMIT}`,
      [userId],
    );
    return rows.map((r) => ({ ...r, savedAt: r.savedAt.toISOString() }));
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
    const [area, rows] = await Promise.all([
      this.areaStats(cell, lat, lng, radiusM, cacheAreaStats),
      this.candidates(userId, lat, lng, radiusM),
    ]);
    const weightOf = (tag: string) => {
      const slot = this.tags.slotOf(tag);
      return userVec && slot !== undefined ? userVec[slot] : 0;
    };
    // The pure part (gate, score, order) is shared with the offline eval (ranker.ts).
    return rankCandidates(rows, area, weightOf, { radiusM, minConfidence: this.gate.minConfidence, weights: this.weights });
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
  //
  // The trust gate's confidence and category rules are in the WHERE too (eligibility.ts
  // is the source of truth; the blocked names are passed in from its constant), so the
  // limit is spent on places that can be offered. confidence is compared as a float4,
  // the column's type, as meetsConfidence() does.
  private async candidates(
    userId: string,
    lat: number,
    lng: number,
    radiusM: number,
  ): Promise<(Candidate & { categories: string[]; overtureId: string })[]> {
    const { rows } = await this.pg.query<Candidate & { categories: string[]; overtureId: string }>(
      `WITH o AS (SELECT ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography AS g),
       top AS (
         SELECT p.id, coalesce(1 - (p.tag_vec <=> t.vec), 0)::float8 AS taste
         FROM places p
         CROSS JOIN o
         LEFT JOIN taste_profiles t ON t.user_id = $1
         WHERE ST_DWithin(p.geom, o.g, $4)
           AND p.location_suspect IS NULL -- its address says it's elsewhere (migration 0015)
           AND p.confidence >= $5::real
           AND (p.overture_id = ANY($7::text[]) OR
                NOT EXISTS (SELECT FROM unnest(p.categories) c WHERE lower(c) = ANY($6::text[])))
         ORDER BY taste DESC, p.id
         LIMIT ${MAX_CANDIDATES}
       )
       SELECT p.id::text, p.name, p.overture_id AS "overtureId",
              ST_Y(p.geom::geometry) AS lat, ST_X(p.geom::geometry) AS lng,
              p.categories[array_length(p.categories, 1)] AS category, p.categories, p.tags,
              top.taste,
              p.chain_locations AS "chainLocations",
              p.confidence::float8 AS confidence,
              ST_Distance(p.geom, o.g)::float8 AS "distanceM",
              p.website, p.instagram, p.phone
       FROM top
       JOIN places p ON p.id = top.id
       CROSS JOIN o
       ORDER BY top.taste DESC, top.id`,
      [userId, lng, lat, radiusM, this.gate.minConfidence, BLOCKED_CATEGORIES, CATEGORY_EXCEPTION_IDS],
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
      `UPDATE quests SET status = 'expired', updated_at = now(), origin = NULL
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

  // The quest checked in today, if any. "Today" is New York's calendar day (NYC is the
  // only area so far), so the next quest arrives at local midnight.
  private async doneToday(userId: string, lat: number, lng: number): Promise<QuestView | null> {
    const { rows } = await this.pg.query<QuestRow>(
      `${QUEST_SELECT} WHERE q.user_id = $1 AND q.status = 'completed'
         AND q.updated_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2
       ORDER BY q.updated_at DESC LIMIT 1`,
      [userId, DAY_TIME_ZONE],
    );
    return rows.length ? toQuestView(rows[0], lat, lng) : null;
  }

  private async offer(userId: string, pick: Scored, lat: number, lng: number): Promise<QuestView> {
    // Whether we inserted or lost a race to another replica, the active row is the
    // answer. It can still be missing: a concurrent request from far away may expire
    // the winner's offer between our INSERT and SELECT. Then the slot is free again,
    // so try again (found by the k6 load test: 2.7% of requests failed here).
    // The rarity is kept from this moment: the area's changes when places are reloaded.
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.pg.query(
        `INSERT INTO quests (user_id, place_id, score, reasons, origin, rarity)
         VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7)
         ON CONFLICT (user_id) WHERE status IN ('offered', 'accepted') DO NOTHING`,
        [userId, pick.id, pick.score, JSON.stringify(pick.reasons), lng, lat, pick.parts.rarity],
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
         p.website, p.instagram, p.phone, q.worth_it AS "worthIt",
         (SELECT CASE WHEN h.was_open IS TRUE THEN 'yes' WHEN h.was_open IS FALSE THEN 'no' ELSE 'didnt_check' END
          FROM place_hours_facts h WHERE h.quest_id = q.id) AS "wasOpen"
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
  wasOpen: WasOpenAnswer | null;
  worthIt: WorthItAnswer | null;
}

function toQuestView(r: QuestRow, lat: number, lng: number): QuestView {
  return {
    id: r.id,
    status: r.status,
    score: r.score,
    reasons: r.reasons,
    createdAt: r.createdAt.toISOString(),
    place: toPlaceView({ ...r, id: r.placeId }, lat, lng),
    wasOpen: r.wasOpen,
    worthIt: r.worthIt,
  };
}

// Distances in the cached deck are from the cell center; report them from the user.
function toPlaceView(
  p: Omit<PlaceView, 'distanceM' | 'hours' | 'openConfirmations' | 'insiderNote'>,
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
    ...NO_HOURS, // today() fills the real ones in, for the places it returns
    insiderNote: null,
  };
}

// Whether the place's regular schedule says it is open at this instant. No schedule, an invalid
// one, or one that cannot say (unknown) is NOT open: the evening rule only offers what is known
// to be open. A check-in's "it was open" answer is not a schedule and never counts here.
function openAt(schedules: Map<string, Schedule> | null, placeId: string, now: Date): boolean {
  return stateAt(schedules?.get(placeId) ?? null, now) === 'open';
}
