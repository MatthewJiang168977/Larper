// The API's Sentry options (../instrument.ts passes them to Sentry.init).
//
// - No SENTRY_DSN (local, tests, k3d, CI): off, nothing is sent.
// - Release: SENTRY_RELEASE, the image's commit (Helm sets it from the image tag).
// - 10% of traces (SENTRY_TRACES_SAMPLE_RATE); health checks, metrics and CORS
//   preflights never. Callers can't change that: their trace headers are dropped before
//   Sentry sees them (incoming-trace.ts).
// - No trace headers on outgoing requests (tracePropagationTargets: []): Clerk and the
//   other services we call get none.
// - The User-Agent is kept (request headers, user_agent.original): it says which
//   browsers and devices an error happens on.
// - Collects no user data at the source (DATA_COLLECTION: Sentry v11's defaults take
//   bodies, headers, cookies, query strings, bound SQL parameters and stack-frame
//   variables), and everything that is sent still goes through scrub.ts:
//   - errors: beforeSend;
//   - traces: traceLifecycle 'static', so a trace is sent as one transaction and
//     beforeSendTransaction runs on it. (v11's default, 'stream', sends spans one by
//     one and skips beforeSendTransaction.) beforeSendSpan scrubs each span as well;
//   - breadcrumbs: beforeBreadcrumb.
//   sdk.spec.ts sends real requests through the SDK and checks what would leave.
import * as Sentry from '@sentry/nestjs';
import { scrubEvent, scrubValue } from './scrub';

const NEVER_TRACED = /^(OPTIONS\b|GET \/(healthz|readyz|metrics)\b)|\/(healthz|readyz|metrics)(\?|$)/;

export const DEFAULT_TRACES_SAMPLE_RATE = 0.1;

// Sentry v11 (which replaced sendDefaultPii with this): nothing about the user or the
// request beyond the method and the route.
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
} satisfies Sentry.NodeOptions['dataCollection'];

export function tracesSampler(
  ctx: { name: string; normalizedRequest?: { url?: string; method?: string }; inheritOrSampleWith: (rate: number) => number },
  rate: number,
): number {
  const req = ctx.normalizedRequest;
  if (req?.method === 'OPTIONS') return 0;
  if (NEVER_TRACED.test(ctx.name) || (req?.url && NEVER_TRACED.test(req.url))) return 0;
  return ctx.inheritOrSampleWith(rate);
}

/** SENTRY_TRACES_SAMPLE_RATE as a number from 0 to 1; unset or invalid gives the default. */
export function tracesSampleRate(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_TRACES_SAMPLE_RATE;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : DEFAULT_TRACES_SAMPLE_RATE;
}

type StaticSpanCallback = Parameters<typeof Sentry.withStaticSpan>[0];

/** Each span of a transaction (static lifecycle), before it is sent. */
export const scrubStaticSpan: StaticSpanCallback = (span) => scrubValue(span);

/**
 * scrubStaticSpan, marked for the static lifecycle. Without withStaticSpan, Sentry
 * ignores a beforeSendSpan when traceLifecycle is 'static'.
 */
export const scrubSpan = Sentry.withStaticSpan(scrubStaticSpan);

export function sentryOptions(env: NodeJS.ProcessEnv = process.env): Sentry.NodeOptions {
  const dsn = env.SENTRY_DSN || undefined;
  const rate = tracesSampleRate(env.SENTRY_TRACES_SAMPLE_RATE);
  return {
    dsn,
    enabled: Boolean(dsn),
    release: env.SENTRY_RELEASE || undefined,
    environment: env.SENTRY_ENVIRONMENT || 'development',
    dataCollection: DATA_COLLECTION,
    tracesSampler: (ctx) => tracesSampler(ctx, rate),
    tracePropagationTargets: [],
    traceLifecycle: 'static',
    beforeSend: scrubEvent,
    beforeSendSpan: scrubSpan,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: (breadcrumb) => scrubValue(breadcrumb),
  };
}
