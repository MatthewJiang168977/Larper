import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG } from '../db/db.module';
import { TagsService } from '../profile/tags.service';
import { topTags } from '../profile/taste';

export const EXPORT_VERSION = 1;
export const ONBOARDING_NOTE = "your onboarding picks only seeded the taste profile; they aren't kept separately";

/** Everything Larper holds about one signed-in user (GET /me/export). */
export interface DataExport {
  version: number;
  exportedAt: string;
  account: { id: string; clerkId: string; createdAt: string };
  /** Onboarding answers aren't kept: they only seeded the taste profile. Said here so it is visible. */
  onboarding: { stored: false; note: string };
  /** The taste profile. */
  taste: null | {
    source: string;
    updatedAt: string;
    topTags: string[];
    /** Weight per tag, non-zero entries only. */
    weights: Record<string, number>;
  };
  /** Every quest offered, newest first, with its place. */
  journal: JournalEntry[];
  /** Quests checked in at, and every check-in attempt (distances only, never a position). */
  checkIns: { completed: CheckInEntry[]; attempts: AttemptEntry[] };
  /** "Was it open?" answers given after a check-in. */
  hoursAnswers: HoursAnswerEntry[];
  savedPlaces: SavedPlaceEntry[];
  weeklyEmail?: { optedInAt: string | null; lastAttemptDay: string | null };
  /** Facts recorded from the curation page (admins only; absent otherwise). */
  curation?: CurationEntry[];
  /** What you reported about places, as the reliability score uses it. Absent if nothing. */
  placeReports?: { kind: string; reportedAt: string; place: PlaceRef }[];
}

export interface CurationEntry {
  kind: string;
  note: string | null;
  hours: string | null;
  recordedAt: string;
  place: PlaceRef;
}

interface PlaceRef {
  id: string;
  name: string;
  category: string | null;
  lat: number;
  lng: number;
}
export interface JournalEntry {
  id: string;
  status: string;
  skipReason: string | null;
  score: number;
  rarity: number | null;
  reasons: unknown;
  simulated: boolean;
  createdAt: string;
  updatedAt: string;
  acceptedAt: string | null;
  completedAt: string | null;
  /** Where you were when it was offered. Null once the offer is resolved (it is dropped then). */
  offeredFrom: { lat: number; lng: number } | null;
  place: PlaceRef;
  /** Your answer to "worth it?" after checking in, and when. */
  worthIt: string | null;
  worthItAt: string | null;
}
export interface CheckInEntry {
  questId: string;
  completedAt: string;
  simulated: boolean;
  place: PlaceRef;
}
export interface AttemptEntry {
  questId: string | null;
  outcome: string;
  distanceM: number | null;
  accuracyM: number | null;
  allowedM: number | null;
  demo: boolean;
  createdAt: string;
}
export interface HoursAnswerEntry {
  questId: string | null;
  wasOpen: boolean | null;
  answeredAt: string;
  place: PlaceRef;
}
export interface SavedPlaceEntry {
  questId: string | null;
  savedAt: string;
  place: PlaceRef;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const PLACE_COLS = `p.id::text AS place_id, p.name AS place_name,
  p.categories[array_length(p.categories, 1)] AS place_category,
  ST_Y(p.geom::geometry) AS place_lat, ST_X(p.geom::geometry) AS place_lng`;
type PlaceCols = { place_id: string; place_name: string; place_category: string | null; place_lat: number; place_lng: number };
const place = (r: PlaceCols): PlaceRef => ({
  id: r.place_id,
  name: r.place_name,
  category: r.place_category,
  lat: r.place_lat,
  lng: r.place_lng,
});

type QuestRow = PlaceCols & {
  id: string;
  status: string;
  skip_reason: string | null;
  score: number;
  rarity: number | null;
  reasons: unknown;
  simulated: boolean;
  created_at: Date;
  updated_at: Date;
  accepted_at: Date | null;
  completed_at: Date | null;
  origin_lat: number | null;
  origin_lng: number | null;
  worth_it: string | null;
  worth_it_at: Date | null;
};
type AttemptRow = {
  quest_id: string | null;
  outcome: string;
  distance_m: number | null;
  accuracy_m: number | null;
  allowed_m: number | null;
  demo: boolean;
  created_at: Date;
};
type AnswerRow = PlaceCols & { quest_id: string | null; was_open: boolean | null; created_at: Date };
type SavedRow = PlaceCols & { quest_id: string | null; created_at: Date };
type ReportRow = PlaceCols & { kind: string; occurred_at: Date };
type CurationRow = PlaceCols & { kind: string; note: string | null; hours_raw: string | null; created_at: Date };

@Injectable()
export class DataExportService {
  constructor(
    @Inject(PG) private readonly pg: Pool,
    private readonly tags: TagsService,
  ) {}

  // Every query is keyed by the caller's own user id (from the verified session) and
  // reads only that user's rows. Nothing from another user, and nothing internal: no
  // outbox, jobs or processed-events rows.
  async export(userId: string, now = new Date()): Promise<DataExport> {
    // One snapshot: the seven reads see the same moment, on one connection, in a read-only
    // REPEATABLE READ transaction (a delete or an accept in between can't tear the file).
    const db = await this.pg.connect();
    let account, taste, quests, attempts, answers, saved, curation, reports;
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      account = await db.query<{ id: string; clerk_id: string; created_at: Date; email_preference: boolean; opted_in_at: Date | null; last_attempt_day: string | null }>(
        `SELECT u.id::text, u.clerk_id, u.created_at, w.user_id IS NOT NULL AS email_preference,
                w.opted_in_at, to_char(w.last_attempt_day, 'YYYY-MM-DD') AS last_attempt_day
         FROM users u LEFT JOIN weekly_email_preferences w ON w.user_id = u.id WHERE u.id = $1`,
        [userId],
      );
      taste = await db.query<{ vec: string; source: string; updated_at: Date }>(
        'SELECT vec::text AS vec, source, updated_at FROM taste_profiles WHERE user_id = $1',
        [userId],
      );
      quests = await db.query<QuestRow>(
        `SELECT q.id::text, q.status, q.skip_reason, q.score::float8 AS score, q.rarity::float8 AS rarity,
                q.reasons - 'simulated' AS reasons,
                coalesce((q.reasons->>'simulated')::boolean, false) AS simulated,
                q.created_at, q.updated_at, q.accepted_at, q.completed_at, q.worth_it, q.worth_it_at,
                ST_Y(q.origin::geometry) AS origin_lat, ST_X(q.origin::geometry) AS origin_lng, ${PLACE_COLS}
         FROM quests q JOIN places p ON p.id = q.place_id
         WHERE q.user_id = $1 ORDER BY q.created_at DESC, q.id DESC`,
        [userId],
      );
      attempts = await db.query<AttemptRow>('SELECT * FROM export_my_checkin_attempts($1)', [userId]);
      answers = await db.query<AnswerRow>(
        `SELECT h.quest_id::text, h.was_open, h.created_at, ${PLACE_COLS}
         FROM place_hours_facts h JOIN places p ON p.id = h.place_id
         WHERE h.user_id = $1 AND h.kind = 'observation' ORDER BY h.created_at DESC, h.id DESC`,
        [userId],
      );
      saved = await db.query<SavedRow>(
        `SELECT s.quest_id::text, s.created_at, ${PLACE_COLS}
         FROM saved_places s JOIN places p ON p.id = s.place_id
         WHERE s.user_id = $1 ORDER BY s.created_at DESC, p.id DESC`,
        [userId],
      );
      curation = await db.query<CurationRow>(
        `SELECT f.kind, f.note, f.hours_raw, f.created_at, ${PLACE_COLS}
         FROM place_facts f JOIN places p ON p.id = f.place_id
         WHERE f.user_id = $1 ORDER BY f.created_at DESC, f.id DESC`,
        [userId],
      );
      reports = await db.query<ReportRow>(
        `SELECT r.kind, r.occurred_at, ${PLACE_COLS}
         FROM place_reports r JOIN places p ON p.id = r.place_id
         WHERE r.user_id = $1 ORDER BY r.occurred_at DESC, r.event_id`,
        [userId],
      );
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      db.release();
    }

    // Gone between the session check and here (the account was just deleted).
    if (!account.rows.length) throw new NotFoundException('no such account');
    const acct = account.rows[0];
    let tasteOut: DataExport['taste'] = null;
    if (taste.rows.length) {
      await this.tags.ready();
      const vec = JSON.parse(taste.rows[0].vec) as number[];
      const weights: Record<string, number> = {};
      vec.forEach((w, slot) => {
        const tag = this.tags.tagOf(slot);
        if (tag !== undefined && w !== 0) weights[tag] = w;
      });
      tasteOut = {
        source: taste.rows[0].source,
        updatedAt: taste.rows[0].updated_at.toISOString(),
        topTags: topTags(vec, this.tags.tagOf, 10),
        weights,
      };
    }

    return {
      version: EXPORT_VERSION,
      exportedAt: now.toISOString(),
      account: { id: acct.id, clerkId: acct.clerk_id, createdAt: acct.created_at.toISOString() },
      onboarding: { stored: false, note: ONBOARDING_NOTE },
      taste: tasteOut,
      journal: quests.rows.map((r) => ({
        id: r.id,
        status: r.status,
        skipReason: r.skip_reason,
        score: r.score,
        rarity: r.rarity,
        reasons: r.reasons,
        simulated: r.simulated,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        acceptedAt: iso(r.accepted_at),
        completedAt: iso(r.completed_at),
        offeredFrom: r.origin_lat === null ? null : { lat: r.origin_lat, lng: r.origin_lng! },
        place: place(r),
        worthIt: r.worth_it,
        worthItAt: iso(r.worth_it_at),
      })),
      checkIns: {
        completed: quests.rows
          .filter((r) => r.status === 'completed')
          .map((r) => ({
            questId: r.id,
            completedAt: (r.completed_at ?? r.updated_at).toISOString(),
            simulated: r.simulated,
            place: place(r),
          })),
        attempts: attempts.rows.map((r) => ({
          questId: r.quest_id,
          outcome: r.outcome,
          distanceM: r.distance_m,
          accuracyM: r.accuracy_m,
          allowedM: r.allowed_m,
          demo: r.demo,
          createdAt: r.created_at.toISOString(),
        })),
      },
      hoursAnswers: answers.rows.map((r) => ({
        questId: r.quest_id,
        wasOpen: r.was_open,
        answeredAt: r.created_at.toISOString(),
        place: place(r),
      })),
      savedPlaces: saved.rows.map((r) => ({ questId: r.quest_id, savedAt: r.created_at.toISOString(), place: place(r) })),
      ...(reports.rows.length > 0 && {
        placeReports: reports.rows.map((r) => ({ kind: r.kind, reportedAt: r.occurred_at.toISOString(), place: place(r) })),
      }),
      ...(curation.rows.length > 0 && {
        curation: curation.rows.map((r) => ({
          kind: r.kind,
          note: r.note,
          hours: r.hours_raw,
          recordedAt: r.created_at.toISOString(),
          place: place(r),
        })),
      }),
      ...(acct.email_preference && { weeklyEmail: { optedInAt: iso(acct.opted_in_at), lastAttemptDay: acct.last_attempt_day } }),
    };
  }
}
