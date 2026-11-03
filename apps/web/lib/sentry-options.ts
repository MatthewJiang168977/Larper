// Sentry options shared by the browser, Node and edge runtimes
// (instrumentation-client.ts, sentry.server.config.ts, sentry.edge.config.ts).
//
// - No DSN (local dev, tests, CI, preview builds without one): the SDK sends nothing.
// - Release: the SDK injects it at build time (next.config.ts: the commit SHA).
// - 10% of traces, no session replay, no default PII (no IPs, cookies or bodies).
// - Every event, transaction and breadcrumb goes through lib/sentry-scrub.ts.
import { scrubEvent, scrubValue } from "./sentry-scrub";

export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || undefined;

export const sentryOptions = {
  dsn: SENTRY_DSN,
  enabled: Boolean(SENTRY_DSN),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV || "development",
  tracesSampleRate: 0.1,
  sendDefaultPii: false,
  // No trace headers on any request. The API's CORS doesn't allow sentry-trace and
  // baggage yet, so sending them would break every API call at the preflight. They
  // get turned on once the API side (Sentry API PR) is deployed.
  tracePropagationTargets: [] as (string | RegExp)[],
  // Browser noise that isn't ours.
  ignoreErrors: [/ResizeObserver loop/, /^AbortError/, /Load failed/, /NetworkError when attempting to fetch/],
  beforeSend: scrubEvent,
  beforeSendTransaction: scrubEvent,
  beforeBreadcrumb: <B>(breadcrumb: B): B => scrubValue(breadcrumb),
};
