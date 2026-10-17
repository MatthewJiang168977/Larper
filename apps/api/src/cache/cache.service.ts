import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { cacheLookups } from '../metrics/metrics';

// Cache-aside over Redis. Redis is an optimization, never a dependency: if it's
// down, every call is a miss and requests go to Postgres (slower, still correct).
@Injectable()
export class CacheService implements OnApplicationShutdown {
  private readonly log = new Logger(CacheService.name);
  private readonly redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    // Fail fast instead of queueing commands while disconnected.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });

  constructor() {
    this.redis.on('error', (err) => this.log.warn(`redis: ${err.message}`));
  }

  // Returns the cached value or computes, stores, and returns it.
  async getOrSet<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
    const cache = key.slice(0, key.indexOf(':')); // "deck", "area"
    try {
      const raw = await this.redis.get(key);
      if (raw !== null) {
        this.log.debug(`hit ${key}`);
        cacheLookups.inc({ cache, result: 'hit' });
        return { value: JSON.parse(raw) as T, hit: true };
      }
      cacheLookups.inc({ cache, result: 'miss' });
    } catch (err) {
      this.log.warn(`cache read failed for ${key}: ${(err as Error).message}`);
      cacheLookups.inc({ cache, result: 'error' });
    }
    this.log.debug(`miss ${key}`);
    const value = await compute();
    this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds).catch((err: Error) => {
      this.log.warn(`cache write failed for ${key}: ${err.message}`);
    });
    return { value, hit: false };
  }

  async onApplicationShutdown() {
    this.redis.disconnect();
  }
}
