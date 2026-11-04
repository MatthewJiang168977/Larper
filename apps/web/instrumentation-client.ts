// Runs in the browser before the app starts (Next's instrumentation-client convention).
import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/sentry-options";

Sentry.init(sentryOptions);

// Navigation spans for App Router transitions.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
