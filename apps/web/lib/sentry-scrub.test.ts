import { describe, expect, it } from "vitest";
import { scrubSpan, scrubStaticSpan, sentryOptions } from "./sentry-options";
import { scrubEvent, scrubString, scrubValue } from "./sentry-scrub";

describe("scrubString", () => {
  it.each([
    ["emails", "no account for jane.doe+x@nyu.edu", "no account for [email]"],
    ["Clerk IDs", "session sess_2abcDEF345ghiJKL678 for user_2xyzXYZ123abcABC456", "session sess_[Filtered] for user_[Filtered]"],
    // Built at runtime: a literal Clerk-style secret key trips gitleaks' Stripe rule.
    ["secret keys", `key ${"sk_" + "live_"}abcdefgh12345678`, "key sk_live_[Filtered]"],
    ["JWTs", "token eyJhbGciOiJSUzI1.eyJzdWIiOiJ1c2Vy.c2lnbmF0dXJl", "token [JWT]"],
    ["bearer tokens", "Authorization: Bearer abc.def-ghi", "Authorization: Bearer [Filtered]"],
    ["query strings", "/quests/today?lat=40.7301&lng=-73.9965", "/quests/today"],
    ["query strings in full URLs", "GET https://api.clerk.com/v1/users?email_address=jane%40nyu.edu&limit=1 failed", "GET https://api.clerk.com/v1/users failed"],
    ["coordinate params outside a URL", "bad input lat=40.7301 lng=-73.9965", "bad input lat=[Filtered] lng=[Filtered]"],
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

  it("drops a dotted key by its last part", () => {
    const out = scrubValue({ "user.email": "a@b.co", "client.address": "203.0.113.9", "url.query": "lat=1", "user.id": "u1", "url.path": "/journal" });
    expect(out).toEqual({ "user.email": "[Filtered]", "client.address": "[Filtered]", "url.query": "[Filtered]", "user.id": "u1", "url.path": "/journal" });
  });

  it("drops the keys the API and workers drop too", () => {
    expect(scrubValue({ bbox: [1, 2, 3, 4], user_id: "u1", client_ip: "203.0.113.9" })).toEqual({
      bbox: "[Filtered]", user_id: "[Filtered]", client_ip: "[Filtered]",
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
        { category: "fetch", data: { method: "GET", url: "https://api.playlarper.com/quests/today" } },
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
      { description: "POST https://api.playlarper.com/quests/:id/checkin", data: { "http.query": "[Filtered]" } },
    ]);
  });

  it("doesn't copy the SDK's scopes in the processing metadata", () => {
    // Sentry removes them before sending; copying them is what made scrubbing slow.
    const capturedSpanScope = { big: "scope" };
    const out = scrubEvent({ message: "/quests/5", sdkProcessingMetadata: { capturedSpanScope } });
    expect(out.message).toBe("/quests/:id");
    expect(out.sdkProcessingMetadata.capturedSpanScope).toBe(capturedSpanScope);
  });

  it("scrubs the dynamic sampling context, which is sent as the trace header", () => {
    const dynamicSamplingContext = { trace_id: "abc", transaction: "clerk users.get user_2xyzXYZ123abcABC456 for a@b.co" };
    const out = scrubEvent({ sdkProcessingMetadata: { dynamicSamplingContext } });
    expect(out.sdkProcessingMetadata.dynamicSamplingContext).toEqual({
      trace_id: "abc",
      transaction: "clerk users.get user_[Filtered] for [email]",
    });
  });

  it("adds no processing metadata to an event without any", () => {
    expect(scrubEvent({ message: "x" })).toEqual({ message: "x" });
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

  it("sends each trace as one transaction, so beforeSendTransaction runs on it", () => {
    // v11's default, "stream", sends spans one by one and skips beforeSendTransaction.
    expect(sentryOptions.traceLifecycle).toBe("static");
    expect(sentryOptions.beforeSendTransaction).toBeDefined();
  });

  it("scrubs every span too, with a callback the static lifecycle accepts", () => {
    // A beforeSendSpan not wrapped in withStaticSpan is ignored with traceLifecycle "static".
    expect(sentryOptions.beforeSendSpan).toBe(scrubSpan);
    expect((scrubSpan as unknown as { _static?: boolean })._static).toBe(true);
    const span = scrubStaticSpan({
      span_id: "a1", trace_id: "b2", start_timestamp: 1, status: "ok",
      data: { "url.full": "https://playlarper.com/quests/5?lat=1.2345", "user.email": "a@b.co" },
      description: "/quests/5",
    });
    expect(span).toMatchObject({ description: "/quests/:id", data: { "url.full": "https://playlarper.com/quests/:id", "user.email": "[Filtered]" } });
  });

  it("scrubs breadcrumbs", () => {
    expect(sentryOptions.beforeBreadcrumb({ message: "hi a@b.co" })).toEqual({ message: "hi [email]" });
  });
});
