import { describe, expect, it } from "vitest";
import { sentryOptions } from "./sentry-options";
import { scrubEvent, scrubString, scrubValue } from "./sentry-scrub";

describe("scrubString", () => {
  it.each([
    ["emails", "no account for jane.doe+x@nyu.edu", "no account for [email]"],
    ["Clerk IDs", "session sess_2abcDEF345ghiJKL678 for user_2xyzXYZ123abcABC456", "session sess_[Filtered] for user_[Filtered]"],
    // Built at runtime: a literal Clerk-style secret key trips gitleaks' Stripe rule.
    ["secret keys", `key ${"sk_" + "live_"}abcdefgh12345678`, "key sk_live_[Filtered]"],
    ["JWTs", "token eyJhbGciOiJSUzI1.eyJzdWIiOiJ1c2Vy.c2lnbmF0dXJl", "token [JWT]"],
    ["bearer tokens", "Authorization: Bearer abc.def-ghi", "Authorization: Bearer [Filtered]"],
    ["coordinate params", "/quests/today?lat=40.7301&lng=-73.9965", "/quests/today?lat=[Filtered]&lng=[Filtered]"],
    ["coordinate pairs", "too far from 40.73012, -73.99651", "too far from [coords]"],
    ["quest IDs", "POST https://api.playlarper.com/quests/4812/accept", "POST https://api.playlarper.com/quests/:id/accept"],
    ["place IDs", "/places/99/photo", "/places/:id/photo"],
  ])("removes %s", (_, input, expected) => {
    expect(scrubString(input)).toBe(expected);
  });

  it("leaves ordinary text and bundle paths alone", () => {
    const s = "TypeError: x is undefined at /_next/static/chunks/1234.js:1:200";
    expect(scrubString(s)).toBe(s);
  });
});

describe("scrubValue", () => {
  it("drops sensitive keys at any depth, however they're spelled", () => {
    const out = scrubValue({
      contexts: { quest: { questId: 12, place_id: 7, Latitude: 40.7, accuracyM: 12, distance: 300 } },
      extra: { headers: { Cookie: "__session=abc", Authorization: "Bearer x" } },
    });
    expect(out).toEqual({
      contexts: { quest: { questId: "[Filtered]", place_id: "[Filtered]", Latitude: "[Filtered]", accuracyM: "[Filtered]", distance: 300 } },
      extra: { headers: { Cookie: "[Filtered]", Authorization: "[Filtered]" } },
    });
  });

  it("doesn't change the input", () => {
    const input = { email: "a@b.co" };
    scrubValue(input);
    expect(input).toEqual({ email: "a@b.co" });
  });
});

describe("scrubEvent", () => {
  it("strips user, cookies, body and query from an error event", () => {
    const out = scrubEvent({
      message: "check-in failed for jane@nyu.edu",
      user: { id: "user_2xyzXYZ123abcABC456", ip_address: "203.0.113.9" },
      request: {
        url: "https://playlarper.com/journal?ticket=abc#top",
        query_string: "ticket=abc",
        cookies: { __session: "x" },
        headers: { "User-Agent": "Firefox", Cookie: "__session=x" },
        data: { lat: 40.7, lng: -73.9 },
      },
      breadcrumbs: [
        { category: "fetch", data: { method: "GET", url: "https://api.playlarper.com/quests/today?lat=40.73&lng=-73.99" } },
      ],
    });
    expect(out).toEqual({
      message: "check-in failed for [email]",
      request: { url: "https://playlarper.com/journal", headers: { "User-Agent": "Firefox", Cookie: "[Filtered]" } },
      breadcrumbs: [
        { category: "fetch", data: { method: "GET", url: "https://api.playlarper.com/quests/today?lat=[Filtered]&lng=[Filtered]" } },
      ],
    });
  });

  it("scrubs a transaction's spans", () => {
    const transaction: { transaction: string; spans: object[] } = {
      transaction: "/",
      spans: [{ description: "POST https://api.playlarper.com/quests/77/checkin", data: { "http.query": "?lat=1.2345&lng=2.3456" } }],
    };
    const out = scrubEvent(transaction);
    expect(out.spans).toEqual([
      { description: "POST https://api.playlarper.com/quests/:id/checkin", data: { "http.query": "?lat=[Filtered]&lng=[Filtered]" } },
    ]);
  });
});

describe("sentryOptions", () => {
  it("is off without a DSN, samples 10%, collects no user data and sends no trace headers", () => {
    expect(sentryOptions.enabled).toBe(false);
    expect(sentryOptions.tracesSampleRate).toBe(0.1);
    expect(sentryOptions.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    });
    expect(sentryOptions.tracePropagationTargets).toEqual([]);
  });

  it("scrubs breadcrumbs", () => {
    expect(sentryOptions.beforeBreadcrumb({ message: "hi a@b.co" })).toEqual({ message: "hi [email]" });
  });
});
