"use client";

import { useAuth } from "@clerk/nextjs";
import { useCallback } from "react";

export interface Me {
  id: string;
  onboarded: boolean;
  topTags: string[];
  /** The shared demo account ("Try the demo"): Midtown stands in for an unusable location. */
  demo?: boolean;
  /**
   * Which export and delete controls the API has switched on. Older API pods omit it:
   * treat a missing value as all false. All false for the demo account.
   */
  privacy?: Privacy;
}

export interface Privacy {
  export: boolean;
  deleteHistory: boolean;
  deleteAccount: boolean;
}

export interface VibeCard {
  id: string;
  title: string;
  blurb: string;
}

// A request is abandoned after this long. A cache miss answers in well under a second
// (ingest is asynchronous: the API returns `surveying` instead of waiting), so this
// only fires when the API or the network is stuck.
export const REQUEST_TIMEOUT_MS = 15_000;

// The API's base URL: NEXT_PUBLIC_API_URL (inlined at build time; required for a
// production build, next.config.ts), else "/api", which only `next dev` proxies.
export const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "") || "/api";

/** A failed API call. `status` is 0 when no response arrived (offline, timeout). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: "http" | "network" | "timeout" = "http",
    /** The API's machine-readable reason, when it gives one (e.g. "too_rough" on a check-in). */
    readonly code?: string,
    /** On a 429: how long until the limit lets this through again, in seconds. */
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * What to tell the user about a failed call: the API's own words for 4xx, plain copy
 * otherwise. Pass `plain` for a call whose 4xx text is written for developers ("unknown
 * card x in liked"): it's said instead. A rate limit keeps the API's words either way
 * (they say how long to wait), and a 401 always means the session ended.
 */
export function describeError(e: unknown, plain?: string): string {
  if (e instanceof ApiError) {
    if (e.kind === "timeout") return "The server is taking too long to answer.";
    if (e.kind === "network") return "Can't reach the server. Check your connection.";
    if (e.status >= 500) return "Something went wrong on our end.";
    if (e.status === 401) return "You've been signed out. Sign in again to carry on.";
    if (e.status === 429) return e.message;
    return plain ?? e.message;
  }
  return plain ?? "Something went wrong.";
}

// A 429's wait: the body's retryAfterS, else the Retry-After header (seconds). The body
// comes first because a browser only shows a cross-origin response's Retry-After when
// the API lists it in Access-Control-Expose-Headers.
function retryAfter(body: { retryAfterS?: unknown }, res: Response): number | undefined {
  const s = Number(body.retryAfterS ?? res.headers.get("retry-after"));
  return Number.isFinite(s) && s > 0 ? s : undefined;
}

// fetch() against the API: a timeout, no cookies, and failures as ApiError. With a
// token, it's sent as the bearer (useApi); without, the call is anonymous.
export async function apiRequest<T>(path: string, init: RequestInit = {}, token?: string | null): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      // Auth is the bearer token below, never a cookie: send none cross-origin.
      credentials: "omit",
      signal: timeout,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch (e) {
    if (timeout.aborted) throw new ApiError("timed out", 0, "timeout");
    throw new ApiError((e as Error).message, 0, "network");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // Nest's validation errors carry a list of messages.
    const message = Array.isArray(body.message) ? body.message.join("; ") : body.message;
    throw new ApiError(
      message ?? `${res.status} ${res.statusText}`,
      res.status,
      "http",
      body.code,
      res.status === 429 ? retryAfter(body, res) : undefined,
    );
  }
  return res.json() as Promise<T>;
}

// apiRequest with the Clerk session token attached. Clerk tokens are short-lived
// (60s); getToken() returns a cached one or refreshes it.
export function useApi() {
  const { getToken } = useAuth();
  return useCallback(
    async <T,>(path: string, init: RequestInit = {}): Promise<T> => apiRequest<T>(path, init, await getToken()),
    [getToken],
  );
}

/** A one-time Clerk sign-in token for the shared demo account (POST /demo/sign-in). */
export async function demoTicket(): Promise<string> {
  const { ticket } = await apiRequest<{ ticket: string }>("/demo/sign-in", { method: "POST" });
  return ticket;
}

/** POST /quests/:id/worth-it. The same refusals as was-open. */
export async function postWorthIt(
  api: <T>(path: string, init?: RequestInit) => Promise<T>,
  questId: string,
  answer: WorthItAnswer,
): Promise<{ worthIt: WorthItAnswer }> {
  return api<{ worthIt: WorthItAnswer }>(`/quests/${questId}/worth-it`, {
    method: "POST",
    body: JSON.stringify({ answer }),
  });
}

/** POST /quests/:id/was-open. 404/405: an API without it. 409: a simulated (demo) check-in. */
export async function postWasOpen(
  api: <T>(path: string, init?: RequestInit) => Promise<T>,
  questId: string,
  answer: WasOpenAnswer,
): Promise<{ wasOpen: WasOpenAnswer }> {
  return api<{ wasOpen: WasOpenAnswer }>(`/quests/${questId}/was-open`, {
    method: "POST",
    body: JSON.stringify({ answer }),
  });
}

// --- quests (shapes mirror apps/api/src/quests/quests.service.ts) -----------

// --- opening hours (apps/api: the hours contract) -----------------------------
// Every new field is optional on the wire: an API that doesn't send them is read as
// `{ status: "unverified" }` and no confirmations.

export type HoursState = "open" | "closed" | "unknown";
/** "HH:MM" on the New York wall clock. `nextDay`: it closes after midnight. */
export interface HoursSpan {
  from: string;
  to: string;
  nextDay: boolean;
}
export type HoursSource = "osm" | "website" | "nyc_open_data" | "alltheplaces" | "manual" | "hand-verified";
export type PlaceHours =
  /** No hours on file. Never shown as "closed". */
  | { status: "unverified" }
  | {
      status: "known";
      /** Right now, New York time. */
      state: HoursState;
      /** Regular hours for today's New York date; [] is closed all day. */
      today: HoursSpan[];
      /** `day`: the New York day `at` falls on, so "opens 9:00" can't be read as today when it is tomorrow. */
      /** Older APIs omit `day` and `weekday`, so the UI omits the transition. */
      nextChange: { at: string; day?: "today" | "tomorrow"; weekday?: Weekday; to: "open" | "closed" } | null;
      source: HoursSource;
      sourceUrl: string | null;
      fetchedAt: string;
      services: { kind: "kitchen" | "bar"; state: HoursState; today: HoursSpan[] }[];
    };
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
/** How long ago the newest "open" answer was; the API never sends a day or a time. */
export type ConfirmationRecency = "this_week" | "this_month" | "a_while_ago";
/** Only ever sent for 3 or more people. */
export interface OpenConfirmations {
  count: number;
  last: ConfirmationRecency;
}
/** One person's answer to "was it open?" after a check-in. */
export type WasOpenAnswer = "yes" | "no" | "didnt_check";
/** After a check-in: was it worth the walk? */
export type WorthItAnswer = "yes" | "meh" | "no";

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
  hours?: PlaceHours;
  openConfirmations?: OpenConfirmations | null;
  /** A curator's one-line note, with when it was written. Older APIs omit it. */
  insiderNote?: { text: string; source: "hand-verified"; notedAt: string } | null;
}

export interface Reasons {
  liked: string[];
  rarest: { tag: string; nearby: number } | null;
  indie: boolean;
}

export type QuestStatus = "offered" | "accepted" | "completed" | "skipped" | "expired";

/** Why a quest was set aside with "Not today" (POST /quests/:id/reason). */
export type SkipReason = "not_my_thing" | "too_far" | "not_today" | "closed";

export interface QuestView {
  id: string;
  status: QuestStatus;
  score: number;
  reasons: Reasons;
  createdAt: string;
  place: PlaceView;
  /** This user's answer to "was it open?" for this quest; null or missing: not answered. */
  wasOpen?: WasOpenAnswer | null;
  /** The answer to "worth it?"; null: not answered; missing: an API without the question. */
  worthIt?: WorthItAnswer | null;
}

export interface DeckItem {
  score: number;
  reasons: Reasons;
  place: PlaceView;
}

export interface Survey {
  /** geohash5 areas whose places are being loaded right now. */
  pending: string[];
  /** Areas whose load failed recently. */
  failed: string[];
  /** Areas outside the demo region: never loaded on request (the API's INGEST_REGION). */
  outside?: string[];
}

export interface Today {
  quest: QuestView | null;
  deck: DeckItem[];
  cache: "hit" | "miss";
  /** Set while nearby areas are being ingested (or failed to be). */
  surveying: Survey | null;
}

export interface JournalEntry {
  id: string;
  status: QuestStatus;
  createdAt: string;
  updatedAt: string;
  name: string;
  category: string;
  reasons: Reasons;
  /** A demo check-in the geofence would have refused: the demo pretended you arrived. */
  simulated?: boolean;
}
