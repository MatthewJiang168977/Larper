import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { AuthModule } from './auth/auth.module';
import { CacheService } from './cache/cache.service';
import { DbModule } from './db/db.module';
import { DemoModule } from './demo/demo.module';
import { HealthController } from './health/health.controller';
import { ProfileController } from './profile/profile.controller';
import { TagsService } from './profile/tags.service';
import { QuestsController } from './quests/quests.controller';
import { JOB_QUEUE, PgJobQueue } from './jobs/job-queue';
import { AreasService } from './quests/areas.service';
import { QuestsService } from './quests/quests.service';
import { ThrottleModule } from './throttle/throttle.module';

@Module({
  // Sentry: route names on traces, and unexpected errors (not 4xx) reported.
  imports: [SentryModule.forRoot(), DbModule, AuthModule, ThrottleModule, DemoModule],
  controllers: [HealthController, ProfileController, QuestsController],
  providers: [
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    TagsService,
    CacheService,
    QuestsService,
    AreasService,
    { provide: JOB_QUEUE, useClass: PgJobQueue },
  ],
})
export class AppModule {}
