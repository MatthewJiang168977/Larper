import { Logger, OnModuleDestroy } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { rateLimitStorageErrors } from '../metrics/metrics';

type StorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

const ALLOW: StorageRecord = { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
const WARN_EVERY_MS = 10_000;

// The limiter's counters live in Redis, but Redis is never a dependency (as for the
// cache): when it's down or slow, every request is let through, unlimited, rather
// than every request failing. Each such check is counted
// (rate_limit_storage_errors_total), and logged at most every 10 s.
export class FailOpenStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly log = new Logger('RateLimit');
  private lastWarn = 0;

  constructor(private readonly inner: ThrottlerStorage & Partial<OnModuleDestroy>) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string) {
    try {
      return await this.inner.increment(key, ttl, limit, blockDuration, throttlerName);
    } catch (err) {
      rateLimitStorageErrors.inc({ throttler: throttlerName });
      const now = Date.now();
      if (now - this.lastWarn >= WARN_EVERY_MS) {
        this.lastWarn = now;
        this.log.warn(`rate limit not applied (failing open): ${(err as Error).message}`);
      }
      return ALLOW;
    }
  }

  onModuleDestroy() {
    return this.inner.onModuleDestroy?.();
  }
}
