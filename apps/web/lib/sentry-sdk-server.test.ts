// @vitest-environment node
//
// What the real Sentry server SDK (the Node runtime: sentry.server.config.ts) would
// send, with the web app's options: a request for /quests/123?lat=..&lng=.. with a
// session cookie, a user, a span that carries an email and looks the user up "in
// Clerk" by their Clerk ID, and an error. Every envelope it would have sent is checked.
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import * as Sentry from "@sentry/nextjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sentryOptions } from "./sentry-options";

const CLERK_USER = "user_2xyzXYZ123abcABC456";
const EMAIL = "jane.doe@nyu.edu";
// Built at runtime: Sentry sends the source lines around each stack frame, and a
// literal near the request below would show up in them.
const SESSION = ["secret", "session", "abc"].join("-");
const IP = ["203", "0", "113", "9"].join(".");

// Nothing of these may leave, in any envelope (headers included).
const NEVER_SENT = [
  "/quests/123",
  CLERK_USER,
  "jane.doe", "nyu.edu",
  "40.7301", "-73.9965",
  SESSION, // the session cookie
  IP,
];
const QUERY_STRING = /\?[A-Za-z0-9_.~%+-]+=/;

type Envelope = [Record<string, unknown>, [{ type: string }, Record<string, unknown>][]];

const envelopes: Envelope[] = [];
const servers: Server[] = [];
let items: { type: string; payload: Record<string, unknown> }[] = [];
let text = "";

const listen = async (server: Server) => {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
};

// Over a bare socket: a fetch from the test would carry its own trace headers, and the
// server would follow their "not sampled".
const rawGet = (port: number, path: string, headers: string[]) =>
  new Promise<void>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write([`GET ${path} HTTP/1.1`, "Host: 127.0.0.1", ...headers, "Connection: close", "", ""].join("\r\n"));
    });
    socket.on("data", () => undefined);
    socket.on("end", () => resolve());
    socket.on("error", reject);
  });

beforeAll(async () => {
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

  // Stands in for api.clerk.com.
  const clerkPort = await listen(createServer((_req, res) => res.end("{}")));
  const webPort = await listen(
    createServer(async (req, res) => {
      Sentry.setUser({ id: CLERK_USER, email: EMAIL, ip_address: IP });
      await Sentry.startSpan(
        { name: `clerk users.get ${CLERK_USER}`, op: "function", attributes: { "user.email": EMAIL, "user.id": CLERK_USER } },
        () => fetch(`http://127.0.0.1:${clerkPort}/v1/users/${CLERK_USER}?email_address=${encodeURIComponent(EMAIL)}`),
      );
      Sentry.captureException(new Error(`render failed for ${EMAIL} at ${req.url}`));
      res.end("ok");
    }),
  );

  await rawGet(webPort, "/quests/123?lat=40.7301&lng=-73.9965", [`Cookie: __session=${SESSION}`]);
  await new Promise((r) => setTimeout(r, 300)); // the server span ends after the response
  await Sentry.flush(5000);

  items = envelopes.flatMap(([, entries]) => entries.map(([header, payload]) => ({ type: header.type, payload })));
  text = JSON.stringify(envelopes);
}, 30_000);

afterAll(async () => {
  await Sentry.close(1000);
  for (const s of servers) s.close();
});

describe("the Sentry server SDK with the web app's options", () => {
  it("sends each trace as one transaction, not as streamed spans", () => {
    expect(Sentry.getClient()?.getOptions().traceLifecycle).toBe("static");
    const types = items.map((i) => i.type);
    expect(types).toContain("transaction");
    expect(types).toContain("event");
    expect(types).not.toContain("span");
  });

  it("traced the request, with the quest ID replaced", () => {
    expect(text).toContain("/quests/:id");
  });

  it("sends no quest ID, Clerk user ID, email, coordinates, cookie, IP or query string", () => {
    for (const s of NEVER_SENT) expect({ leaked: s, found: text.includes(s) }).toEqual({ leaked: s, found: false });
    expect(text).not.toMatch(QUERY_STRING);
  });

  it("sends no user", () => {
    for (const i of items) expect(i.payload.user).toBeUndefined();
  });
});
