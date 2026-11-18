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
