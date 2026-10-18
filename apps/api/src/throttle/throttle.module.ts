import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { FailOpenStorage } from './fail-open.storage';
import { IpLimitGuard, UserLimitGuard } from './guards';

// Rate limits (limits.ts), counted in Redis so they hold across API replicas. One
// round trip per limit window per request: a Lua script (INCR, PTTL, and a block key
// once over the limit), sent with EVAL.
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      useFactory: () => ({
        throttlers: [], // each guard brings its own (guards.ts)
        storage: new FailOpenStorage(
          new ThrottlerStorageRedisService(process.env.REDIS_URL ?? 'redis://localhost:6379', {
            // As the cache: fail fast while Redis is unreachable instead of queueing,
            // and give up on a slow answer, so a request waits at most this long.
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
            commandTimeout: 250,
          }),
        ),
      }),
    }),
  ],
  providers: [UserLimitGuard, { provide: APP_GUARD, useClass: IpLimitGuard }],
  exports: [UserLimitGuard],
})
export class ThrottleModule {}
