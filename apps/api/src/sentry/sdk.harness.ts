// Run by sdk.spec.ts in a Node process of its own, not in Jest: Jest's module registry
// keeps http out of reach of the SDK's instrumentation. It starts the real Sentry SDK
// with options.ts's options and a transport that only records envelopes, sends real
// requests through it, and prints what would have been sent to Sentry.
//
// Usage: node sdk.harness.js [all | span-hook-only | transaction-hook-only]
// (span-hook-only and transaction-hook-only leave out the other trace hook, so each
// one is shown to scrub on its own.)
//
// The values that must not leave come from the environment (sdk.spec.ts sets them),
// not from this file: Sentry sends the source lines around each stack frame, and a
// literal here would show up in them.
import type { AddressInfo } from 'node:net';
import * as net from 'node:net';
import * as Sentry from '@sentry/nestjs';
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
const MARKER = '--- envelopes ---';

const mode = process.argv[2] ?? 'all';
const envelopes: unknown[] = [];

const options = sentryOptions({
  SENTRY_DSN: 'https://0123456789abcdef0123456789abcdef@o1.ingest.us.sentry.io/2', // never contacted
  SENTRY_TRACES_SAMPLE_RATE: '1',
  SENTRY_ENVIRONMENT: 'test',
});
if (mode === 'span-hook-only') delete options.beforeSendTransaction;
if (mode === 'transaction-hook-only') delete options.beforeSendSpan;
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
  const clerk = http.createServer((_req, res) => res.end('{}'));
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
  await rawGet(apiPort, `/quests/123/accept?${QUERY}`, [`Authorization: Bearer ${TOKEN}`, `Cookie: __session=${SESSION}`]);
  await new Promise((r) => setTimeout(r, 300)); // the server span ends after the response
  await Sentry.flush(5000);
  clerk.close();
  api.close();

  const traceLifecycle = Sentry.getClient()?.getOptions().traceLifecycle;
  process.stdout.write(`${MARKER}\n${JSON.stringify({ traceLifecycle, envelopes })}\n`);
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
