// Runs in the browser before the app starts (Next's instrumentation-client convention).
import * as Sentry from "@sentry/nextjs";
import { initAnalytics } from "@/lib/analytics";
import { sentryOptions } from "@/lib/sentry-options";

Sentry.init(sentryOptions);

// PostHog, on the production deployment only (lib/analytics.ts). It loads in its own
// chunk, so it doesn't hold up start-up.
void initAnalytics();

// Navigation spans for App Router transitions.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
