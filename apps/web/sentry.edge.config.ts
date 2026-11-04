// The edge runtime, loaded from instrumentation.ts (nothing runs there today).
import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/sentry-options";

Sentry.init(sentryOptions);
