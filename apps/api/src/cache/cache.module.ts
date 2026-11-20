import { Global, Module } from '@nestjs/common';
import { CacheService } from './cache.service';

// One CacheService (one Redis connection) for the whole app, like DbModule's pool: global,
// so the auth module's UsersService can clear a purged account's decks too.
@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
