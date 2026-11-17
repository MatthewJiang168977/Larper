import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { AuthModule } from './auth/auth.module';
import { CacheService } from './cache/cache.service';
import { DbModule } from './db/db.module';
import { DemoModule } from './demo/demo.module';
import { HealthController } from './health/health.controller';
import { clerkUserDeleterFromEnv, CLERK_USER_DELETER } from './privacy/clerk-user-deleter';
import { DataDeletionService } from './privacy/data-deletion';
import { DataExportService } from './privacy/data-export';
import { MeDataController } from './privacy/me-data.controller';
import { ProfileController } from './profile/profile.controller';
import { TagsService } from './profile/tags.service';
import { QuestsController } from './quests/quests.controller';
import { SavedPlacesController } from './quests/saved-places.controller';
import { JOB_QUEUE, PgJobQueue } from './jobs/job-queue';
import { AreasService } from './quests/areas.service';
import { QuestsService } from './quests/quests.service';
import { ThrottleModule } from './throttle/throttle.module';

@Module({
  // Sentry: route names on traces, and unexpected errors (not 4xx) reported.
  imports: [SentryModule.forRoot(), DbModule, AuthModule, ThrottleModule, DemoModule],
  controllers: [HealthController, ProfileController, QuestsController, SavedPlacesController, MeDataController],
  providers: [
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    TagsService,
    CacheService,
    QuestsService,
    AreasService,
    DataExportService,
    DataDeletionService,
    // Null unless CLERK_DELETE_USERS is on: then DELETE /me also deletes the Clerk user.
    { provide: CLERK_USER_DELETER, useFactory: () => clerkUserDeleterFromEnv(process.env) },
    { provide: JOB_QUEUE, useClass: PgJobQueue },
  ],
})
export class AppModule {}
