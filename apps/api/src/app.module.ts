import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CacheService } from './cache/cache.service';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { ProfileController } from './profile/profile.controller';
import { TagsService } from './profile/tags.service';
import { QuestsController } from './quests/quests.controller';
import { QuestsService } from './quests/quests.service';

@Module({
  imports: [DbModule, AuthModule],
  controllers: [HealthController, ProfileController, QuestsController],
  providers: [TagsService, CacheService, QuestsService],
})
export class AppModule {}
