import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { AuthModule } from './auth/auth.module';
import { CacheModule } from './cache/cache.module';
import { DbModule } from './db/db.module';
import { DemoModule } from './demo/demo.module';
import { HealthController } from './health/health.controller';
import { clerkUserDeleterFromEnv, CLERK_USER_DELETER } from './privacy/clerk-user-deleter';
import { webhookSecretFromEnv } from './privacy/clerk-webhook';
import { CLERK_WEBHOOK_SECRET, ClerkWebhookController } from './privacy/clerk-webhook.controller';
import { DataDeletionService } from './privacy/data-deletion';
import { DataExportService } from './privacy/data-export';
import { PRIVACY_DELETES, privacyDeletesFromEnv } from './privacy/privacy-deletes';
import { MeDataController } from './privacy/me-data.controller';
import { PendingClerkDeletions } from './privacy/pending-clerk-deletions';
import { ProfileController } from './profile/profile.controller';
import { TagsService } from './profile/tags.service';
import { QuestsController } from './quests/quests.controller';
import { SavedPlacesController } from './quests/saved-places.controller';
import { JOB_QUEUE, PgJobQueue } from './jobs/job-queue';
import { AreasService } from './quests/areas.service';
import { QuestsService } from './quests/quests.service';
import { ThrottleModule } from './throttle/throttle.module';
import { WeeklyEmailPreferenceController, WeeklyEmailUnsubscribeController } from './weekly-email/weekly-email.controller';
import { WEEKLY_EMAIL, WeeklyEmailService, weeklyEmailFromEnv } from './weekly-email/weekly-email.service';

@Module({
  // Sentry: route names on traces, and unexpected errors (not 4xx) reported.
  imports: [SentryModule.forRoot(), DbModule, CacheModule, AuthModule, ThrottleModule, DemoModule],
  controllers: [HealthController, ProfileController, QuestsController, SavedPlacesController, MeDataController,
    ClerkWebhookController, WeeklyEmailPreferenceController, WeeklyEmailUnsubscribeController],
  providers: [
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    TagsService,
    QuestsService,
    AreasService,
    DataExportService,
    DataDeletionService,
    WeeklyEmailService,
    { provide: WEEKLY_EMAIL, useFactory: () => weeklyEmailFromEnv(process.env) },
    PendingClerkDeletions,
    // Null unless CLERK_WEBHOOK_SIGNING_SECRET is set: then POST /webhooks/clerk handles
    // user.deleted (a bad value fails the API at startup).
    { provide: CLERK_WEBHOOK_SECRET, useFactory: () => webhookSecretFromEnv(process.env) },
    // Null unless PRIVACY_DELETES=all: then DELETE /me also deletes the Clerk user.
    { provide: CLERK_USER_DELETER, useFactory: () => clerkUserDeleterFromEnv(process.env) },
    // 'off' unless PRIVACY_DELETES=history; a bad value fails the API at startup.
    { provide: PRIVACY_DELETES, useFactory: () => privacyDeletesFromEnv(process.env) },
    { provide: JOB_QUEUE, useClass: PgJobQueue },
  ],
})
export class AppModule {}
