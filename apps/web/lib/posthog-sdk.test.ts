// What the real posthog-js would send, with the web app's options (lib/analytics.ts):
// the page is /?at=<lat>,<lng> (a position in the URL, plus ad-click and campaign
// parameters) and the visitor came from a search, the demo flag is set, and a few
// events are recorded. Every request it makes
// is caught here (fetch, XMLHttpRequest, sendBeacon, and any script it would load).
// posthog-js keeps its own reference to fetch, so it's imported after the stand-ins.
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { analyticsConfig, initAnalytics, setDemo, track } from "./analytics";

const LAT = "40.7301";
const LNG = "-73.9965";

type Sent = { url: string; body: string };
const sent: Sent[] = [];
const scripts: string[] = [];

// Request bodies as text: posthog-js gzips its batches.
async function bodyText(body: unknown): Promise<string> {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Blob) {
    // jsdom's Blob has no arrayBuffer(); its FileReader does.
    const bytes = await new Promise<Buffer>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(Buffer.from(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(body);
    });
    return (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
  }
  return String(body);
}

const pending: Promise<void>[] = [];

// A Storage that remembers every write. (Node's own experimental localStorage global
// can hide jsdom's, so the test brings its own.)
function memoryStorage(): Storage & { writes: string[] } {
  const m = new Map<string, string>();
  const writes: string[] = [];
  return {
    writes,
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => {
      writes.push(k);
      m.set(k, String(v));
    },
  };
}
const local = memoryStorage();
const session = memoryStorage();

beforeAll(async () => {
  window.history.replaceState({}, "", `/?at=${LAT},${LNG}&gclid=GCLIDVALUE&utm_campaign=CAMPAIGNVALUE#frag`);
  // posthog-js drops events from user agents it takes for bots, jsdom's included.
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  });
  Object.defineProperty(document, "referrer", { value: "https://www.google.com/search?q=niche+spots", configurable: true });
  vi.spyOn(window, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    pending.push(bodyText(init?.body).then((body) => void sent.push({ url, body })));
    return Promise.resolve(new Response('{"status":1}', { status: 200 }));
  });
  vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(function (this: XMLHttpRequest, _m: string, url: string | URL) {
    (this as unknown as { _url: string })._url = String(url);
  });
  vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(function (this: XMLHttpRequest, body) {
    const url = (this as unknown as { _url: string })._url;
    pending.push(bodyText(body).then((b) => void sent.push({ url, body: b })));
  });
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: (url: string, body: unknown) => {
      pending.push(bodyText(body).then((b) => void sent.push({ url, body: b })));
      return true;
    },
  });
  const append = document.head.appendChild.bind(document.head);
  vi.spyOn(Node.prototype, "appendChild").mockImplementation(function (this: Node, node) {
    if (node instanceof HTMLScriptElement) scripts.push(node.src);
    return append.call(this === document.head ? document.head : this, node) as never;
  });

  for (const [name, store] of [["localStorage", local], ["sessionStorage", session]] as const) {
    Object.defineProperty(window, name, { value: store, configurable: true });
    Object.defineProperty(globalThis, name, { value: store, configurable: true });
  }
  const { default: posthog } = await import("posthog-js");
  await initAnalytics({ key: "phc_testkey", vercelEnv: "production" }, () => Promise.resolve({ default: posthog }));
  setDemo(true);
  track("landing_viewed");
  track("quest_offered", { category: "bakery", distance_bucket: "1-2km" });
  track("checkin_attempted", { result: "too_far", simulated: false });
  // Out of the batch queue now.
  window.dispatchEvent(new Event("pagehide"));
  (posthog as unknown as { _requestQueue?: { unload?: () => void } })._requestQueue?.unload?.();
  await new Promise((r) => setTimeout(r, 4000));
  await Promise.all(pending);
}, 15_000);

afterAll(() => vi.restoreAllMocks());

function events(): { event: string; properties: Record<string, unknown> }[] {
  return sent.flatMap(({ body }) => {
    try {
      const parsed = JSON.parse(body);
      return parsed.batch ?? (Array.isArray(parsed) ? parsed : [parsed]);
    } catch {
      return [];
    }
  });
}

describe("posthog-js with Larper's options", () => {
  it("sends only to /ingest, and loads no scripts", () => {
    expect(sent.length).toBeGreaterThan(0);
    for (const { url } of sent) expect(new URL(url, window.location.href).pathname).toMatch(/^\/ingest\//);
    expect(scripts.filter(Boolean)).toEqual([]);
  });

  it("sends the three events and nothing automatic", () => {
    expect(events().map((e) => e.event).sort()).toEqual(["checkin_attempted", "landing_viewed", "quest_offered"]);
  });

  it("sends our properties and the demo flag", () => {
    const offered = events().find((e) => e.event === "quest_offered")!;
    expect(offered.properties).toMatchObject({ category: "bakery", distance_bucket: "1-2km", demo: true, $geoip_disable: true });
  });

  it("never sends the URL's query or fragment, campaign parameters, or the search words", () => {
    expect(events().length).toBeGreaterThan(0); // the bodies were read
    const all = sent.map((s) => s.url + s.body).join("\n");
    expect(all).not.toContain(LAT);
    expect(all).not.toContain(LNG);
    for (const never of ["niche", "?at=", "GCLIDVALUE", "CAMPAIGNVALUE", "#frag", "gclid", "utm_"]) {
      expect(all).not.toContain(never);
    }
  });

  it("stores nothing on the device", () => {
    expect(document.cookie).toBe("");
    // It only checks that storage works (writes a probe key and removes it).
    const PROBES = ["__mplssupport__", "test"];
    for (const store of [local, session]) {
      expect(store.length).toBe(0);
      expect(store.writes.filter((k) => !PROBES.includes(k))).toEqual([]);
    }
  });

  it("asks for no person profile and no flags", () => {
    for (const e of events()) expect(e.properties.$process_person_profile).toBe(false);
    expect(sent.some(({ url }) => /\/(flags|decide)\b/.test(url))).toBe(false);
    expect(analyticsConfig({ key: "k", vercelEnv: "production" })!.options.advanced_disable_flags).toBe(true);
  });
});
