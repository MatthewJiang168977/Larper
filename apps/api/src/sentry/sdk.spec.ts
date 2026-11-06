// What the real Sentry SDK would send, with the API's options: sdk.harness.ts sends a
// request for /quests/123/accept?lat=..&lng=.. (with a bearer token and a session
// cookie, and a caller's trace headers), sets a user, looks the user up "in Clerk" by
// their Clerk ID, and reports an error. Every envelope it would have sent is checked
// here, and the headers Clerk got.
//
// The harness runs in a Node process of its own (see its header), compiled from
// TypeScript into a temporary directory.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as ts from 'typescript';

const CLERK_USER = 'user_2xyzXYZ123abcABC456';
const MARKER = '--- envelopes ---';
const CALLER_TRACE = 'c0ffee00c0ffee00c0ffee00c0ffee00';
const HARNESS_ENV = {
  HARNESS_CLERK_USER: CLERK_USER,
  HARNESS_EMAIL: 'jane.doe@nyu.edu',
  HARNESS_IP: '203.0.113.9',
  HARNESS_TOKEN: 'secret-token-abc',
  HARNESS_SESSION: 'secret-session-abc',
  HARNESS_QUERY: 'lat=40.7301&lng=-73.9965',
  HARNESS_CALLER_TRACE: CALLER_TRACE,
};

// Nothing of these may leave, in any envelope (headers included).
const NEVER_SENT = [
  '/quests/123', // a quest ID in a path
  CLERK_USER,
  'jane.doe', 'nyu.edu', // the email, in a span attribute, the user, an error and a query
  '40.7301', '-73.9965', // the coordinates in the query
  'secret-token-abc', 'secret-session-abc', // the bearer token and the session cookie
  '203.0.113.9', // the user's IP
];
const QUERY_STRING = /\?[A-Za-z0-9_.~%+-]+=/;

type Item = { type: string; payload: Record<string, unknown> };
type Run = {
  traceLifecycle: string;
  clerkHeaders: string[][]; // the header names of each request Clerk got
  envelopes: [unknown, [{ type: string }, unknown][]][];
  items: Item[];
  text: string;
};

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'larper-sentry-sdk-'));
  for (const name of ['scrub', 'options', 'incoming-trace', 'sdk.harness']) {
    const source = readFileSync(join(__dirname, `${name}.ts`), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    writeFileSync(join(dir, `${name}.js`), outputText);
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(mode: 'all' | 'span-hook-only' | 'transaction-hook-only' | 'not-sampled'): Run {
  const out = spawnSync(process.execPath, [join(dir, 'sdk.harness.js'), mode], {
    // The temporary directory has no node_modules: resolve @sentry/nestjs from the API's.
    env: { ...process.env, ...HARNESS_ENV, NODE_PATH: resolve(__dirname, '../../node_modules'), SENTRY_DSN: '' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (out.status !== 0) throw new Error(`harness failed (${out.status}): ${out.stderr}`);
  const json = out.stdout.slice(out.stdout.indexOf(MARKER) + MARKER.length);
  const parsed = JSON.parse(json) as Omit<Run, 'items' | 'text'>;
  const items = parsed.envelopes.flatMap(([, entries]) =>
    entries.map(([header, payload]) => ({ type: header.type, payload: payload as Record<string, unknown> })),
  );
  return { ...parsed, items, text: JSON.stringify(parsed.envelopes) };
}

function expectClean(text: string) {
  for (const s of NEVER_SENT) expect({ leaked: s, found: text.includes(s) }).toEqual({ leaked: s, found: false });
  expect(text).not.toMatch(QUERY_STRING);
}

const transactions = (r: Run) => r.items.filter((i) => i.type === 'transaction').map((i) => i.payload);

describe('the Sentry SDK with the API options', () => {
  let all: Run;
  beforeAll(() => {
    all = run('all');
  }, 60_000);

  it('sends each trace as one transaction, not as streamed spans', () => {
    expect(all.traceLifecycle).toBe('static');
    const types = all.items.map((i) => i.type);
    expect(types).toContain('transaction');
    expect(types).toContain('event');
    expect(types).not.toContain('span');
  });

  it('traced the request, with the quest ID replaced', () => {
    expect(all.text).toContain('/quests/:id/accept');
  });

  it('sends no quest ID, Clerk user ID, email, coordinates, token, cookie, IP or query string', () => {
    expectClean(all.text);
  });

  it('sends no user', () => {
    for (const i of all.items) expect(i.payload.user).toBeUndefined();
  });

  it("scrubs a code-named root span's name in the envelopes' trace header", () => {
    // The trace header comes from the event's processing metadata, not from its body.
    const names = all.envelopes
      .map(([header]) => (header as { trace?: { transaction?: string } }).trace?.transaction)
      .filter((name) => name?.startsWith('sync clerk user'));
    expect(names.length).toBeGreaterThan(0); // the error's and the transaction's
    for (const name of names) expect(name).toBe('sync clerk user user_[Filtered] [email]');
  });

  it("doesn't continue the caller's trace or take its baggage", () => {
    expect(all.text).not.toContain(CALLER_TRACE);
    expect(all.text).not.toContain('caller'); // the baggage's sentry-environment
  });

  it('sends no trace headers to Clerk', () => {
    expect(all.clerkHeaders.length).toBeGreaterThan(0);
    for (const names of all.clerkHeaders) {
      expect(names).toContain('host'); // it did see the request's headers
      for (const name of ['sentry-trace', 'baggage', 'traceparent']) expect(names).not.toContain(name);
    }
  });

  it("lets no caller force a trace: a sampled flag and a sample_rand of 0 don't beat a rate of 0", () => {
    const r = run('not-sampled');
    expect(r.items.map((i) => i.type)).toContain('event');
    expect(transactions(r)).toEqual([]);
    expect(r.text).not.toContain(CALLER_TRACE);
    // Unsampled, the SDK would still send sentry-trace (…-0) and baggage to Clerk.
    expect(r.clerkHeaders.length).toBeGreaterThan(0);
    for (const names of r.clerkHeaders) {
      for (const name of ['sentry-trace', 'baggage', 'traceparent']) expect(names).not.toContain(name);
    }
  }, 60_000);

  it('scrubs the spans with beforeSendSpan alone', () => {
    const r = run('span-hook-only');
    const txs = transactions(r);
    expect(txs.length).toBeGreaterThan(0);
    // beforeSendSpan sees the root span (the transaction's name and trace data) and
    // every child span; the rest of the event is beforeSendTransaction's.
    const spanParts = txs.map((t) => ({
      transaction: t.transaction,
      trace: (t.contexts as { trace?: unknown } | undefined)?.trace,
      spans: t.spans,
    }));
    expect(JSON.stringify(spanParts)).toContain('/quests/:id/accept');
    expectClean(JSON.stringify(spanParts));
  }, 60_000);

  it('scrubs the transactions with beforeSendTransaction alone', () => {
    const r = run('transaction-hook-only');
    const txs = transactions(r);
    expect(txs.length).toBeGreaterThan(0);
    expect(JSON.stringify(txs)).toContain('/quests/:id/accept');
    expectClean(JSON.stringify(txs));
  }, 60_000);
});
