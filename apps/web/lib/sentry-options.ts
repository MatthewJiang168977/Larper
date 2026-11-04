// Sentry options shared by the browser, Node and edge runtimes
// (instrumentation-client.ts, sentry.server.config.ts, sentry.edge.config.ts).
//
// - No DSN (local dev, tests, CI, preview builds without one): the SDK sends nothing.
// - Release: the SDK injects it at build time (next.config.ts: the commit SHA).
// - 10% of traces, no session replay.
// - Collects no user data at the source (DATA_COLLECTION: Sentry v11's defaults take
//   bodies, headers, cookies, query strings and stack-frame variables).
// - Every event, transaction and breadcrumb goes through lib/sentry-scrub.ts.
import type * as Sentry from "@sentry/nextjs";
import { scrubEvent, scrubValue } from "./sentry-scrub";

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
  // No trace headers on any request. The API's CORS doesn't allow sentry-trace and
  // baggage yet, so sending them would break every API call at the preflight. They
  // get turned on once the API side (Sentry API PR) is deployed.
  tracePropagationTargets: [] as (string | RegExp)[],
  // Browser noise that isn't ours.
  ignoreErrors: [/ResizeObserver loop/, /^AbortError/, /Load failed/, /NetworkError when attempting to fetch/],
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
  beforeBreadcrumb: <B>(breadcrumb: B): B => scrubValue(breadcrumb),
} satisfies Parameters<typeof Sentry.init>[0];
