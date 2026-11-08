import type { CaptureResult, PostHog } from "posthog-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyticsConfig,
  clearDemo,
  demoKnown,
  distanceBucket,
  initAnalytics,
  questProps,
  resetAnalyticsForTests,
  scrubCapture,
  setDemo,
  stripUrl,
  track,
} from "./analytics";

afterEach(() => resetAnalyticsForTests());

const PROD = { key: "phc_test", vercelEnv: "production" };

function fakePostHog() {
  const capture = vi.fn();
  const init = vi.fn();
  const posthog = { capture, init } as unknown as PostHog;
  return { capture, init, load: () => Promise.resolve({ default: posthog }) };
}

describe("distanceBucket", () => {
  it.each([
    [0, "<0.5km"],
    [499, "<0.5km"],
    [500, "0.5-1km"],
    [999, "0.5-1km"],
    [1000, "1-2km"],
    [1999, "1-2km"],
    [2000, "2-5km"],
    [4999, "2-5km"],
    [5000, ">5km"],
    [306_000, ">5km"],
  ])("%d m is %s", (m, bucket) => expect(distanceBucket(m)).toBe(bucket));
});

describe("questProps", () => {
  it("keeps only the category and a distance bucket", () => {
    const place = { id: "p1", name: "Secret Bakery", lat: 40.7, lng: -74, category: "bakery", distanceM: 1200 };
    expect(questProps(place)).toEqual({ category: "bakery", distance_bucket: "1-2km" });
  });
});

describe("analyticsConfig", () => {
  it("is off without a key, or anywhere but the production deployment", () => {
    expect(analyticsConfig({ vercelEnv: "production" })).toBeNull();
    expect(analyticsConfig({ key: "phc_test", vercelEnv: "preview" })).toBeNull();
    expect(analyticsConfig({ key: "phc_test" })).toBeNull();
  });

  it("is cookieless, explicit-events-only, and goes through /ingest", () => {
    const c = analyticsConfig(PROD)!;
    expect(c.key).toBe("phc_test");
    expect(c.options).toMatchObject({
      api_host: "/ingest",
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
      advanced_disable_flags: true,
      disable_external_dependency_loading: true,
      before_send: scrubCapture,
    });
  });
});

describe("stripUrl", () => {
  it("drops the query (a ?at= position, Clerk's tokens) and the fragment", () => {
    expect(stripUrl("https://playlarper.com/?at=40.7308,-73.9973")).toBe("https://playlarper.com/");
    expect(stripUrl("https://playlarper.com/sign-in?__clerk_ticket=abc#x")).toBe("https://playlarper.com/sign-in");
  });

  it("leaves everything else alone", () => {
    expect(stripUrl("/journal")).toBe("/journal");
    expect(stripUrl(42)).toBe(42);
    expect(stripUrl("bakery")).toBe("bakery");
  });
});

describe("scrubCapture", () => {
  const event = (properties: Record<string, unknown>, extra: Partial<CaptureResult> = {}): CaptureResult =>
    ({ uuid: "u1", event: "quest_offered", properties, ...extra }) as CaptureResult;

  it("strips every URL, drops person properties and turns GeoIP off", () => {
    const out = scrubCapture(
      event(
        {
          $current_url: "https://playlarper.com/?at=40.73,-73.99",
          $referrer: "https://www.google.com/search?q=larper#top",
          $initial_current_url: "https://playlarper.com/?at=1,2",
          $pathname: "/",
          category: "bakery",
          $set: { email: "a@b.c" },
          $set_once: { x: 1 },
          $unset: ["y"],
          ph_keyword: "niche spots",
          $search_engine: "google",
          $geoip_disable: false,
        },
        { $set: { email: "a@b.c" } },
      ),
    )!;
    expect(out.properties).toEqual({
      $current_url: "https://playlarper.com/",
      $referrer: "https://www.google.com/search",
      $initial_current_url: "https://playlarper.com/",
      $pathname: "/",
      category: "bakery",
      $search_engine: "google",
      $geoip_disable: true,
    });
    expect(out).not.toHaveProperty("$set");
    expect(out.event).toBe("quest_offered");
    expect(out.uuid).toBe("u1");
  });

  it("passes a dropped event through as dropped", () => {
    expect(scrubCapture(null)).toBeNull();
  });
});

describe("initAnalytics and track", () => {
  it("sends nothing and loads nothing where analytics is off", async () => {
    const ph = fakePostHog();
    const load = vi.fn(ph.load);
    await initAnalytics({ key: "phc_test", vercelEnv: "preview" }, load);
    track("landing_viewed");
    expect(load).not.toHaveBeenCalled();
    expect(ph.capture).not.toHaveBeenCalled();
  });

  it("does nothing before init (tests, dev)", () => {
    expect(() => track("journal_opened")).not.toThrow();
  });

  it("initialises once with the key and options, and sends events captured while it loaded", async () => {
    const ph = fakePostHog();
    const loaded = initAnalytics(PROD, ph.load);
    track("landing_viewed");
    track("quest_offered", { category: "bakery", distance_bucket: "<0.5km" });
    await loaded;
    expect(ph.init).toHaveBeenCalledTimes(1);
    expect(ph.init).toHaveBeenCalledWith("phc_test", analyticsConfig(PROD)!.options);
    expect(ph.capture.mock.calls).toEqual([
      ["landing_viewed", {}],
      ["quest_offered", { category: "bakery", distance_bucket: "<0.5km" }],
    ]);
    await initAnalytics(PROD, ph.load);
    expect(ph.init).toHaveBeenCalledTimes(1);
  });

  it("adds the demo flag once it's known", async () => {
    const ph = fakePostHog();
    await initAnalytics(PROD, ph.load);
    track("demo_clicked");
    setDemo(true);
    track("not_today_reason", { reason: "too_far" });
    setDemo(false);
    track("checkin_attempted", { result: "checked_in", simulated: false });
    expect(ph.capture.mock.calls).toEqual([
      ["demo_clicked", {}],
      ["not_today_reason", { demo: true, reason: "too_far" }],
      ["checkin_attempted", { demo: false, result: "checked_in", simulated: false }],
    ]);
  });

  it("forgets the flag on clearDemo: later events carry none, and it's unknown again", async () => {
    const ph = fakePostHog();
    await initAnalytics(PROD, ph.load);
    expect(demoKnown()).toBe(false);
    setDemo(true);
    expect(demoKnown()).toBe(true);
    track("journal_opened");
    clearDemo();
    expect(demoKnown()).toBe(false);
    track("journal_opened");
    expect(ph.capture.mock.calls).toEqual([
      ["journal_opened", { demo: true }],
      ["journal_opened", {}],
    ]);
  });

  it("knows false as an answer, so a signed-out visitor's flag isn't asked for again", () => {
    setDemo(false);
    expect(demoKnown()).toBe(true);
  });

  it("survives posthog-js failing to load or to capture", async () => {
    await initAnalytics(PROD, () => Promise.reject(new Error("chunk failed")));
    expect(() => track("landing_viewed")).not.toThrow();

    resetAnalyticsForTests();
    const ph = fakePostHog();
    ph.capture.mockImplementation(() => {
      throw new Error("boom");
    });
    await initAnalytics(PROD, ph.load);
    expect(() => track("landing_viewed")).not.toThrow();
  });
});
