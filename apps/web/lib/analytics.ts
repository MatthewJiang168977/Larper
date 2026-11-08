// Product analytics (PostHog): a short list of explicit events, nothing automatic.
//
// - Only on the production deployment (NEXT_PUBLIC_VERCEL_ENV=production) with a
//   project key (NEXT_PUBLIC_POSTHOG_KEY). Everywhere else track() does nothing.
// - Cookieless ("always"): nothing is stored on the device, no identify(), no person
//   profiles. PostHog counts visitors with a hash on its servers that resets daily.
//   The PostHog project must have "Enable cookieless tracking" on, or it drops these.
// - No autocapture, page views, page leaves, session replay, surveys, heatmaps, web
//   vitals, exceptions, feature flags or remote scripts.
// - Sent through this site (app/ingest/[...path]/route.ts), not straight to PostHog.
// - What leaves: the event name, the properties below, and PostHog's own (browser,
//   OS, screen size, the page). scrubCapture() takes the query and the fragment off
//   every URL (/?at=lat,lng is a position; Clerk can put tokens there), drops any
//   person properties and the search words posthog-js reads out of a search engine
//   referrer, and asks PostHog to skip GeoIP. Campaign parameters (utm_*, gclid…)
//   aren't collected at all.
//   No coordinates, addresses, place names or IDs: a quest is its category and a
//   distance bucket.
import type { CaptureResult, PostHog, PostHogConfig } from "posthog-js";
import type { SkipReason } from "./api";

/** How far a quest is, coarsely. */
export type DistanceBucket = "<0.5km" | "0.5-1km" | "1-2km" | "2-5km" | ">5km";

export function distanceBucket(m: number): DistanceBucket {
  if (m < 500) return "<0.5km";
  if (m < 1000) return "0.5-1km";
  if (m < 2000) return "1-2km";
  if (m < 5000) return "2-5km";
  return ">5km";
}

type QuestProps = { category: string; distance_bucket: DistanceBucket };

/** What a check-in came to. */
export type CheckinResult = "checked_in" | "too_far" | "too_rough" | "failed";

// Every event and exactly what it may carry. `demo` (the shared demo account or not)
// is added by track() once it's known.
export interface AnalyticsEvents {
  landing_viewed: undefined;
  demo_clicked: undefined;
  demo_signed_in: undefined;
  onboarding_finished: undefined;
  journal_opened: undefined;
  quest_offered: QuestProps;
  quest_accepted: QuestProps;
  quest_skipped: QuestProps;
  quest_not_today: QuestProps;
  /** The optional reason after "Not today", as a second event. */
  not_today_reason: { reason: SkipReason };
  checkin_attempted: { result: CheckinResult; simulated: boolean };
}

export type AnalyticsEvent = keyof AnalyticsEvents;

/** A quest as analytics sees it: its kind of place and roughly how far. */
export const questProps = (place: { category: string; distanceM: number }): QuestProps => ({
  category: place.category,
  distance_bucket: distanceBucket(place.distanceM),
});

/** Takes the query and the fragment off a URL; anything else is returned as it was. */
export function stripUrl(value: unknown): unknown {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

// $set and friends would describe a person (there are none here); ph_keyword is what
// the visitor typed into a search engine (from a google.com/search?q=… referrer).
const DROPPED = new Set(["$set", "$set_once", "$unset", "ph_keyword"]);

/** Runs on every event just before it's sent (PostHog's before_send). */
export function scrubCapture(cr: CaptureResult | null): CaptureResult | null {
  if (!cr) return null;
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cr.properties ?? {})) {
    if (DROPPED.has(key)) continue;
    properties[key] = stripUrl(value);
  }
  // Last, so nothing above can turn it off.
  properties.$geoip_disable = true;
  return { uuid: cr.uuid, event: cr.event, timestamp: cr.timestamp, properties };
}

export const API_HOST = "/ingest";

/** PostHog's options, or null when this deployment sends nothing. */
export function analyticsConfig(env: {
  key?: string;
  vercelEnv?: string;
}): { key: string; options: Partial<PostHogConfig> } | null {
  if (!env.key || env.vercelEnv !== "production") return null;
  return {
    key: env.key,
    options: {
      api_host: API_HOST,
      ui_host: "https://us.posthog.com",
      cookieless_mode: "always",
      person_profiles: "never",
      persistence: "memory",
      disable_persistence: true,
      save_referrer: false,
      save_campaign_params: false,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      rageclick: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_exceptions: false,
      capture_performance: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_product_tours: true,
      disable_conversations: true,
      disable_web_experiments: true,
      // No /flags call (we use no flags) and so no remote config; and no extra scripts.
      advanced_disable_flags: true,
      disable_external_dependency_loading: true,
      before_send: scrubCapture,
    },
  };
}

type Queued = [AnalyticsEvent, Record<string, unknown>];

// Events from before posthog-js has loaded (it loads in its own chunk, after start-up).
const MAX_QUEUED = 50;
let queue: Queued[] | null = null;
let client: PostHog | null = null;
let demo: boolean | undefined;

/** Starts PostHog, if this deployment sends analytics. Called once, in the browser. */
export function initAnalytics(
  env = { key: process.env.NEXT_PUBLIC_POSTHOG_KEY, vercelEnv: process.env.NEXT_PUBLIC_VERCEL_ENV },
  load: () => Promise<{ default: PostHog }> = () => import("posthog-js"),
): Promise<void> {
  const config = analyticsConfig(env);
  if (!config || queue || client) return Promise.resolve();
  queue = [];
  return load().then(
    ({ default: posthog }) => {
      posthog.init(config.key, config.options);
      client = posthog;
      for (const [event, props] of queue ?? []) send(event, props);
      queue = null;
    },
    () => {
      // Analytics never breaks the app: a chunk that won't load means no events.
      queue = null;
    },
  );
}

/** Whether this visitor is on the shared demo account, for every later event. */
export function setDemo(value: boolean) {
  demo = value;
}

/** Whether setDemo() has an answer yet, so a page can skip asking the API. */
export function demoKnown(): boolean {
  return demo !== undefined;
}

/** Forgets the account's flag: someone signed out or switched accounts. */
export function clearDemo() {
  demo = undefined;
}

/** Records one event. Does nothing where analytics is off. */
export function track<E extends AnalyticsEvent>(
  event: E,
  ...[props]: AnalyticsEvents[E] extends undefined ? [] : [AnalyticsEvents[E]]
): void {
  const all: Record<string, unknown> = { ...(demo === undefined ? {} : { demo }), ...props };
  if (client) send(event, all);
  else if (queue && queue.length < MAX_QUEUED) queue.push([event, all]);
}

function send(event: AnalyticsEvent, props: Record<string, unknown>) {
  try {
    client?.capture(event, props);
  } catch {
    // Never let analytics throw into the app.
  }
}

/** Test only: back to a fresh page load. */
export function resetAnalyticsForTests() {
  queue = null;
  client = null;
  demo = undefined;
}
