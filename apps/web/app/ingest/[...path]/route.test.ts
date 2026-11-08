// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientIp, MAX_BODY_BYTES, POST } from "./route";

const upstream = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

beforeEach(() => {
  upstream.mockReset();
  upstream.mockResolvedValue(new Response('{"status":"Ok"}', { status: 200, headers: { "content-type": "application/json", "set-cookie": "ph=1" } }));
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => upstream(url, init));
});
afterEach(() => vi.unstubAllGlobals());

const SESSION = "eyJhbGciOiJSUzI1NiJ9.session-jwt.sig";

function request(path: string, init: { body?: string; headers?: Record<string, string>; method?: string } = {}) {
  return new NextRequest(`https://playlarper.com${path}`, {
    method: init.method ?? "POST",
    body: init.body ?? '{"batch":[]}',
    headers: {
      "content-type": "text/plain",
      "user-agent": "Mozilla/5.0 Chrome/141",
      cookie: `__session=${SESSION}; __client_uat=1793936139`,
      authorization: `Bearer ${SESSION}`,
      referer: "https://playlarper.com/?at=40.7301,-73.9965",
      origin: "https://playlarper.com",
      "x-forwarded-for": "203.0.113.9, 10.0.0.1",
      ...init.headers,
    },
  });
}

describe("/ingest", () => {
  it("passes an event batch on to PostHog with only the body, the query, the type, the UA and the IP", async () => {
    const res = await POST(request("/ingest/e/?compression=gzip-js&retry_count=2", { body: "BATCH" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"status":"Ok"}');
    expect(res.headers.get("set-cookie")).toBeNull();

    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://us.i.posthog.com/e/?compression=gzip-js&retry_count=2");
    expect(init.method).toBe("POST");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe("BATCH");
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      "content-type": "text/plain",
      "user-agent": "Mozilla/5.0 Chrome/141",
      "x-forwarded-for": "203.0.113.9",
    });
  });

  it("never forwards the session cookie, a bearer token, or the page's URL", async () => {
    await POST(request("/ingest/e/"));
    const sent = JSON.stringify([...new Headers(upstream.mock.calls[0][1].headers)]) + upstream.mock.calls[0][0];
    for (const never of [SESSION, "__session", "__client_uat", "Bearer", "40.7301", "playlarper.com"]) {
      expect(sent).not.toContain(never);
    }
  });

  it("forwards only the SDK's own query parameters", async () => {
    await POST(request("/ingest/e/?compression=gzip-js&at=40.7301,-73.9965&token=abc&api_key=x&retry_count=1"));
    expect(upstream.mock.calls[0][0]).toBe("https://us.i.posthog.com/e/?compression=gzip-js&retry_count=1");
  });

  it("sends no query at all when none of it is the SDK's", async () => {
    await POST(request("/ingest/e?at=40.7301,-73.9965"));
    expect(upstream.mock.calls[0][0]).toBe("https://us.i.posthog.com/e/");
  });

  it.each(["/ingest/e", "/ingest/i/v0/e/", "/ingest/batch/"])("accepts %s", async (path) => {
    expect((await POST(request(path))).status).toBe(200);
  });

  it.each(["/ingest/flags/", "/ingest/decide/", "/ingest/s/", "/ingest/api/projects/", "/ingest/static/recorder.js", "/ingest/array/phc/config", "/ingest/", "/ingest/e/../api"])(
    "is no general proxy to PostHog: %s is a 404, never sent",
    async (path) => {
      expect((await POST(request(path))).status).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it("refuses a body over the cap", async () => {
    const res = await POST(request("/ingest/e/", { body: "x".repeat(MAX_BODY_BYTES + 1) }));
    expect(res.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("answers 502 when PostHog can't be reached, and passes PostHog's own errors through", async () => {
    upstream.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect((await POST(request("/ingest/e/"))).status).toBe(502);
    upstream.mockResolvedValueOnce(new Response('{"type":"authentication_error"}', { status: 401 }));
    expect((await POST(request("/ingest/e/"))).status).toBe(401);
  });
});

describe("clientIp", () => {
  it("takes the first X-Forwarded-For address, else X-Real-IP, else none", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(new Headers())).toBeNull();
  });
});
