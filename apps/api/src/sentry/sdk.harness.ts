// Run by sdk.spec.ts in a Node process of its own, not in Jest: Jest's module registry
// keeps http out of reach of the SDK's instrumentation. It starts the real Sentry SDK
// with options.ts's options and a transport that only records envelopes, sends real
// requests through it, and prints what would have been sent to Sentry.
//
// Usage: node sdk.harness.js [all | span-hook-only | transaction-hook-only | not-sampled]
// (span-hook-only and transaction-hook-only leave out the other trace hook, so each
// one is shown to scrub on its own; not-sampled sets the sample rate to 0.)
//
// The request carries a caller's trace headers, sampled and with a baggage sample_rand
// of 0, as anyone could send them. It also prints the headers "Clerk" received. After
// it, a root span named in code (outside any request) reports an error.
//
// The values that must not leave come from the environment (sdk.spec.ts sets them),
// not from this file: Sentry sends the source lines around each stack frame, and a
// literal here would show up in them.
import type { AddressInfo } from 'node:net';
import * as net from 'node:net';
import * as Sentry from '@sentry/nestjs';
import { ignoreIncomingTraceHeaders } from './incoming-trace';
import { sentryOptions } from './options';

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};
const CLERK_USER = need('HARNESS_CLERK_USER');
const EMAIL = need('HARNESS_EMAIL');
const IP = need('HARNESS_IP');
const TOKEN = need('HARNESS_TOKEN');
const SESSION = need('HARNESS_SESSION');
const QUERY = need('HARNESS_QUERY'); // lat=..&lng=..
const CALLER_TRACE = need('HARNESS_CALLER_TRACE'); // 32 hex digits
const MARKER = '--- envelopes ---';

const mode = process.argv[2] ?? 'all';
const envelopes: unknown[] = [];

const options = sentryOptions({
  SENTRY_DSN: 'https://0123456789abcdef0123456789abcdef@o1.ingest.us.sentry.io/2', // never contacted
  SENTRY_TRACES_SAMPLE_RATE: mode === 'not-sampled' ? '0' : '1',
  SENTRY_ENVIRONMENT: 'test',
});
if (mode === 'span-hook-only') delete options.beforeSendTransaction;
if (mode === 'transaction-hook-only') delete options.beforeSendSpan;
// As instrument.ts does.
ignoreIncomingTraceHeaders();
Sentry.init({
  ...options,
  transport: () => ({
    send: async (envelope) => {
      envelopes.push(envelope);
      return {};
    },
    flush: async () => true,
  }),
});

// Loaded after Sentry.init, as main.ts loads the app after instrument.ts.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require('node:http') as typeof import('node:http');

const listen = (server: import('node:http').Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

async function main() {
  // Stands in for api.clerk.com: the API looks users up by their Clerk ID.
  // The header names it got, from rawHeaders: this process drops incoming trace
  // headers from req.headers (incoming-trace.ts), Clerk wouldn't.
  const clerkHeaders: string[][] = [];
  const clerk = http.createServer((req, res) => {
    clerkHeaders.push(req.rawHeaders.filter((_, i) => i % 2 === 0).map((name) => name.toLowerCase()));
    res.end('{}');
  });
  const clerkPort = await listen(clerk);

  const api = http.createServer(async (req, res) => {
    Sentry.setUser({ id: CLERK_USER, email: EMAIL, ip_address: IP });
    await Sentry.startSpan(
      { name: `clerk users.get ${CLERK_USER}`, op: 'function', attributes: { 'user.email': EMAIL, 'user.id': CLERK_USER } },
      () => fetch(`http://127.0.0.1:${clerkPort}/v1/users/${CLERK_USER}?email_address=${encodeURIComponent(EMAIL)}`),
    );
    Sentry.captureException(new Error(`accept failed for ${EMAIL} at ${req.url}`));
    res.end('ok');
  });
  const apiPort = await listen(api);

  // Over a bare socket: a fetch from here would carry this process's own trace
  // headers, and the API would follow their "not sampled".
  const callerSpan = 'aaaaaaaaaaaaaaaa';
  await rawGet(apiPort, `/quests/123/accept?${QUERY}`, [
    `Authorization: Bearer ${TOKEN}`,
    `Cookie: __session=${SESSION}`,
    'Origin: https://playlarper.com',
    `sentry-trace: ${CALLER_TRACE}-${callerSpan}-1`,
    `baggage: sentry-trace_id=${CALLER_TRACE},sentry-sample_rand=0.000001,sentry-sample_rate=1,sentry-sampled=true,sentry-environment=caller`,
    `traceparent: 00-${CALLER_TRACE}-${callerSpan}-01`,
  ]);
  await new Promise((r) => setTimeout(r, 300)); // the server span ends after the response

  // A root span named in code, outside any request (as a job would start one), with an
  // error inside it: its name goes into the envelopes' trace header too.
  Sentry.startSpan({ name: `sync clerk user ${CLERK_USER} ${EMAIL}`, op: 'task', forceTransaction: true }, () => {
    Sentry.captureException(new Error('sync failed'));
  });
  await Sentry.flush(5000);
  clerk.close();
  api.close();

  const traceLifecycle = Sentry.getClient()?.getOptions().traceLifecycle;
  process.stdout.write(`${MARKER}\n${JSON.stringify({ traceLifecycle, clerkHeaders, envelopes })}\n`);
}

function rawGet(port: number, path: string, headers: string[]) {
  return new Promise<void>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([`GET ${path} HTTP/1.1`, 'Host: 127.0.0.1', ...headers, 'Connection: close', '', ''].join('\r\n'));
    });
    socket.on('data', () => undefined);
    socket.on('end', () => resolve());
    socket.on('error', reject);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
