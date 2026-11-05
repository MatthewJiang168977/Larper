// Incoming trace headers are dropped before Sentry reads them: sentry-trace and baggage
// (and W3C traceparent and tracestate). Anyone can send them, and Sentry would follow
// them: a "sampled" flag, or a baggage sample_rand of 0, traces the request whatever
// our sample rate (Sentry quota), and the caller's baggage would be sent with our
// transaction.
//
// Checking Origin wouldn't help: a script can send Origin: https://playlarper.com, and
// a browser on another site can't send these headers anyway (CORS preflight). The web
// app sends none for now (lib/sentry-options.ts, tracePropagationTargets: []). If it
// starts to, web and API traces won't be linked until this changes.
//
// Node publishes each request on http.server.request.start before the server emits
// 'request', and Sentry reads the headers in its 'request' handler, so they are gone by
// then. The rest of the app never reads them.
import { subscribe } from 'node:diagnostics_channel';
import type { IncomingMessage } from 'node:http';

export const INCOMING_TRACE_HEADERS = ['sentry-trace', 'baggage', 'traceparent', 'tracestate'];

function dropTraceHeaders(message: unknown) {
  const headers = (message as { request?: IncomingMessage }).request?.headers;
  if (!headers) return;
  for (const name of INCOMING_TRACE_HEADERS) delete headers[name];
}

let subscribed = false;

/** Once, before Sentry.init (instrument.ts). */
export function ignoreIncomingTraceHeaders() {
  if (subscribed) return;
  subscribed = true;
  subscribe('http.server.request.start', dropTraceHeaders);
}
