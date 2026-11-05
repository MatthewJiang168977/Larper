// Sentry options shared by the browser, Node and edge runtimes
// (instrumentation-client.ts, sentry.server.config.ts, sentry.edge.config.ts).
//
// - No DSN (local dev, tests, CI, preview builds without one): the SDK sends nothing.
// - Release: the SDK injects it at build time (next.config.ts: the commit SHA).
// - 10% of traces, no session replay.
// - Collects no user data at the source (DATA_COLLECTION: Sentry v11's defaults take
//   bodies, headers, cookies, query strings and stack-frame variables).
// - Everything that is sent goes through lib/sentry-scrub.ts:
//   - errors: beforeSend;
//   - traces: traceLifecycle "static", so a trace is sent as one transaction and
//     beforeSendTransaction runs on it. (v11's default, "stream", sends spans one by
//     one and skips beforeSendTransaction.) beforeSendSpan scrubs each span as well;
//   - breadcrumbs: beforeBreadcrumb.
//   sentry-sdk.test.ts (browser) and sentry-sdk-server.test.ts (Node) run the real SDK
//   and check what would leave.
import * as Sentry from "@sentry/nextjs";
import { scrubEvent, scrubValue } from "./sentry-scrub";

type StaticSpanCallback = Parameters<typeof Sentry.withStaticSpan>[0];

/** Each span of a transaction (static lifecycle), before it is sent. */
export const scrubStaticSpan: StaticSpanCallback = (span) => scrubValue(span);

/**
 * scrubStaticSpan, marked for the static lifecycle. Without withStaticSpan, Sentry
 * ignores a beforeSendSpan when traceLifecycle is "static".
 */
export const scrubSpan = Sentry.withStaticSpan(scrubStaticSpan);

export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || undefined;

// Sentry v11 replaced sendDefaultPii with this: nothing about the user or the request
// beyond the method and the route.
export const DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
} satisfies NonNullable<Parameters<typeof Sentry.init>[0]>["dataCollection"];

export const sentryOptions = {
  dsn: SENTRY_DSN,
  enabled: Boolean(SENTRY_DSN),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV || "development",
  tracesSampleRate: 0.1,
  dataCollection: DATA_COLLECTION,
  // No trace headers on any request: the API ignores them (anyone could send them to
  // force a trace; apps/api/src/sentry/incoming-trace.ts), so web and API traces
  // aren't linked.
  tracePropagationTargets: [] as (string | RegExp)[],
  // Browser noise that isn't ours.
  ignoreErrors: [/ResizeObserver loop/, /^AbortError/, /Load failed/, /NetworkError when attempting to fetch/],
  traceLifecycle: "static" as const,
  beforeSend: scrubEvent,
  beforeSendSpan: scrubSpan,
  beforeSendTransaction: scrubEvent,
  beforeBreadcrumb: <B>(breadcrumb: B): B => scrubValue(breadcrumb),
} satisfies Parameters<typeof Sentry.init>[0];
