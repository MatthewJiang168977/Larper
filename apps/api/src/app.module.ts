import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { ProfileController } from './profile/profile.controller';
import { TagsService } from './profile/tags.service';

@Module({
  imports: [DbModule, AuthModule],
  controllers: [HealthController, ProfileController],
  providers: [TagsService],
})
export class AppModule {}
