// Sentry, started before anything else is imported (main.ts's first line), so its
// OpenTelemetry instrumentation can patch http, express and pg as they load. What is
// collected, sampled and scrubbed: sentry/options.ts. Incoming trace headers are
// ignored: sentry/incoming-trace.ts.
import * as Sentry from '@sentry/nestjs';
import { ignoreIncomingTraceHeaders } from './sentry/incoming-trace';
import { sentryOptions } from './sentry/options';

ignoreIncomingTraceHeaders();
Sentry.init(sentryOptions());
