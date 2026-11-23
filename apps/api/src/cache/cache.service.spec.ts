import { Logger } from '@nestjs/common';
import { CacheService } from './cache.service';

// forgetUser runs after a delete, so what it logs when Redis fails must not name the user.
// A real CacheService; only Redis's scan is made to fail (REDIS_URL points at nothing).
describe('CacheService.forgetUser logging', () => {
  const USER_ID = '90210';
  let cache: CacheService;

  beforeEach(() => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    cache = new CacheService();
  });
  afterEach(async () => {
    await cache.onApplicationShutdown();
    jest.restoreAllMocks();
  });

  it('logs no user id (or key) when the Redis call fails', async () => {
    const logs = [
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined),
    ];
    // The failure's own text names the user and the key: it must not reach the log.
    (cache as unknown as { redis: { scanStream: () => never } }).redis.scanStream = () => {
      throw new Error(`scan deck:*:${USER_ID}:* failed for user ${USER_ID}`);
    };
    await expect(cache.forgetUser(USER_ID)).resolves.toBeUndefined();
    const text = JSON.stringify(logs.flatMap((l) => l.mock.calls.filter((c) => !String(c[0]).startsWith('redis:'))));
    expect(text).toContain('cache clear');
    expect(text).not.toContain(USER_ID);
    expect(text).not.toContain('deck:');
  });
});

// getOrSet runs on every quest request; a deck key holds the user id, so neither the key nor
// Redis's error text (which can quote it) may be logged.
describe('CacheService.getOrSet logging', () => {
  const KEY = 'deck:v4:90210:v1:dr5reg:1500:c0.7';
  let cache: CacheService;

  beforeEach(() => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    cache = new CacheService();
  });
  afterEach(async () => {
    await cache.onApplicationShutdown();
    jest.restoreAllMocks();
  });

  it('names the cache, never the key, on a hit, a miss and a failed read or write', async () => {
    const logs = [
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined),
    ];
    const redis = (cache as unknown as { redis: { get: unknown; set: unknown } }).redis;
    redis.get = async () => {
      throw new Error(`GET ${KEY} failed`);
    };
    redis.set = async () => {
      throw new Error(`SET ${KEY} failed`);
    };
    await expect(cache.getOrSet(KEY, 60, async () => 1)).resolves.toEqual({ value: 1, hit: false });
    await new Promise((r) => setImmediate(r)); // the write is fire-and-forget
    redis.get = async () => '2';
    await expect(cache.getOrSet(KEY, 60, async () => 1)).resolves.toEqual({ value: 2, hit: true });
    const text = JSON.stringify(logs.flatMap((l) => l.mock.calls.filter((c) => !String(c[0]).startsWith('redis:'))));
    expect(text).toContain('deck cache read failed');
    expect(text).toContain('deck cache write failed');
    expect(text).toContain('deck hit');
    expect(text).not.toContain('90210');
    expect(text).not.toContain('deck:');
  });
});
