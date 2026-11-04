// What the real Sentry browser SDK would send, with the web app's options: the page
// loads at /quests/123?lat=..&lng=.., a user is set, a span carries an email and looks
// the user up "in Clerk" by their Clerk ID (a real fetch, to a local server), and an
// error is reported. Every envelope it would have sent is checked here.
//
// It loads @sentry/nextjs's browser build, the one Next bundles for the client (Node's
// resolution here would pick the server build).
import { realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sentryOptions } from "./sentry-options";

const CLERK_USER = "user_2xyzXYZ123abcABC456";
const EMAIL = "jane.doe@nyu.edu";

// Nothing of these may leave, in any envelope (headers included).
const NEVER_SENT = [
  "/quests/123", // a quest ID in a path (the page's URL)
  CLERK_USER,
  "jane.doe", "nyu.edu", // the email: a span attribute, the user, an error, a query
  "40.7301", "-73.9965", // the coordinates in the page's query
  "203.0.113.9", // the user's IP
];
const QUERY_STRING = /\?[A-Za-z0-9_.~%+-]+=/;

type SentryClient = typeof import("@sentry/nextjs");
type Envelope = [Record<string, unknown>, [{ type: string }, Record<string, unknown>][]];

const require = createRequire(import.meta.url);
const Sentry: SentryClient = require(join(realpathSync(join(__dirname, "../node_modules/@sentry/nextjs")), "build/cjs/index.client.js"));

const envelopes: Envelope[] = [];
let clerk: Server;
let items: { type: string; payload: Record<string, unknown> }[] = [];
let text = "";

beforeAll(async () => {
  // Stands in for api.clerk.com.
  clerk = createServer((_req, res) => res.end("{}"));
  await new Promise<void>((r) => clerk.listen(0, "127.0.0.1", r));
  const clerkPort = (clerk.address() as AddressInfo).port;

  window.history.replaceState({}, "", "/quests/123?lat=40.7301&lng=-73.9965");
  Sentry.init({
    ...sentryOptions,
    dsn: "https://0123456789abcdef0123456789abcdef@o1.ingest.us.sentry.io/2", // never contacted
    enabled: true,
    tracesSampleRate: 1,
    transport: () => ({
      send: async (envelope: unknown) => {
        envelopes.push(envelope as Envelope);
        return {};
      },
      flush: async () => true,
    }),
  });

  Sentry.setUser({ id: CLERK_USER, email: EMAIL, ip_address: "203.0.113.9" });
  await Sentry.startSpan(
    { name: `clerk users.get ${CLERK_USER}`, op: "function", attributes: { "user.email": EMAIL, "user.id": CLERK_USER } },
    () => fetch(`http://127.0.0.1:${clerkPort}/v1/users/${CLERK_USER}?email_address=${encodeURIComponent(EMAIL)}`),
  );
  Sentry.captureException(new Error(`accept failed for ${EMAIL} at ${window.location.href}`));

  // The pageload transaction ends after a second without activity.
  await new Promise((r) => setTimeout(r, 2500));
  await Sentry.flush(5000);

  items = envelopes.flatMap(([, entries]) => entries.map(([header, payload]) => ({ type: header.type, payload })));
  text = JSON.stringify(envelopes);
}, 30_000);

afterAll(async () => {
  await Sentry.close(1000);
  clerk.close();
});

describe("the Sentry browser SDK with the web app's options", () => {
  it("sends each trace as one transaction, not as streamed spans", () => {
    expect(Sentry.getClient()?.getOptions().traceLifecycle).toBe("static");
    const types = items.map((i) => i.type);
    expect(types).toContain("transaction");
    expect(types).toContain("event");
    expect(types).not.toContain("span");
  });

  it("traced the page load, with the quest ID replaced", () => {
    expect(text).toContain("/quests/:id");
  });

  it("sends no quest ID, Clerk user ID, email, coordinates, IP or query string", () => {
    for (const s of NEVER_SENT) expect({ leaked: s, found: text.includes(s) }).toEqual({ leaked: s, found: false });
    expect(text).not.toMatch(QUERY_STRING);
  });

  it("sends no user", () => {
    for (const i of items) expect(i.payload.user).toBeUndefined();
  });
});
