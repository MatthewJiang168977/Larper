// Sentry, started before anything else is imported (main.ts's first line), so its
// OpenTelemetry instrumentation can patch http, express and pg as they load.
//
// - No SENTRY_DSN (local, tests, k3d, CI): off, nothing is sent.
// - Release: SENTRY_RELEASE, the image's commit (Helm sets it from the image tag).
// - 10% of traces (SENTRY_TRACES_SAMPLE_RATE), following the caller's decision when a
//   trace comes in from the web app; health checks, metrics and CORS preflights never.
// - Collects no user data at the source (DATA_COLLECTION: Sentry v11's defaults take
//   bodies, headers, cookies, query strings, bound SQL parameters and stack-frame
//   variables), and every event, transaction and breadcrumb still goes through
//   sentry/scrub.ts.
import * as Sentry from '@sentry/nestjs';
import { scrubEvent, scrubValue } from './sentry/scrub';

const NEVER_TRACED = /^(OPTIONS\b|GET \/(healthz|readyz|metrics)\b)|\/(healthz|readyz|metrics)(\?|$)/;

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

export function sentryOptions(env: NodeJS.ProcessEnv = process.env): Sentry.NodeOptions {
  const dsn = env.SENTRY_DSN || undefined;
  const rate = Number(env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1);
  return {
    dsn,
    enabled: Boolean(dsn),
    release: env.SENTRY_RELEASE || undefined,
    environment: env.SENTRY_ENVIRONMENT || 'development',
    dataCollection: DATA_COLLECTION,
    tracesSampler: (ctx) => tracesSampler(ctx, rate),
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: (breadcrumb) => scrubValue(breadcrumb),
  };
}

Sentry.init(sentryOptions());
