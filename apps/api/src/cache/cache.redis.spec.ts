import Redis from 'ioredis';
import { CacheService } from './cache.service';

// forgetUser against a real Redis: after DELETE /me or DELETE /me/history a user's cached
// decks (deck:<version>:<userId>:...) go, and nobody else's do. Skipped unless
// TEST_REDIS_URL is set (CI's db job runs a Redis service; the file name matches its
// `redis.spec` step).
const REDIS_URL = process.env.TEST_REDIS_URL;
const describeRedis = REDIS_URL ? describe : describe.skip;

describeRedis('CacheService.forgetUser (real Redis)', () => {
  let redis: Redis;
  let cache: CacheService;
  const run = `t${Date.now()}`;
  // User ids are numbers; these are far above anything a test database hands out, and the
  // run id keeps the area key from clashing with another run.
  const A = '9000000001';
  const B = '9000000011';
  const keys = {
    deckA1: `deck:v4:${A}:v1:dr5reg:1500`,
    deckA2: `deck:v3:${A}:v2:dr5reg:3000`,
    deckB: `deck:v4:${B}:v1:dr5reg:1500`,
    area: `area:v1:${run}:1500`,
  };

  beforeAll(async () => {
    process.env.REDIS_URL = REDIS_URL;
    redis = new Redis(REDIS_URL!);
    cache = new CacheService();
    await new Promise((r) => setTimeout(r, 200));
  });
  afterAll(async () => {
    await redis.del(...Object.values(keys));
    redis.disconnect();
    await cache.onApplicationShutdown();
  });

  it("drops that user's decks of every version, and nothing else", async () => {
    for (const k of Object.values(keys)) await redis.set(k, '1', 'EX', 60);
    await cache.forgetUser(A);
    expect(await redis.exists(keys.deckA1, keys.deckA2)).toBe(0);
    expect(await redis.exists(keys.deckB, keys.area)).toBe(2); // B's id merely starts with A's
  });

  it("never matches another user's deck whose last segment starts with the id (radius + floor)", async () => {
    // A user whose id equals a radius: their delete must not touch everyone's decks at that radius.
    const C = '9000000021';
    const mine = `deck:v4:${C}:v1:dr5reg:1500c0.7`;
    const theirs = `deck:v4:${B}:v1:dr5reg:${C}c0.7`;
    await redis.set(mine, '1', 'EX', 60);
    await redis.set(theirs, '1', 'EX', 60);
    try {
      await cache.forgetUser(C);
      expect(await redis.exists(mine)).toBe(0);
      expect(await redis.exists(theirs)).toBe(1);
    } finally {
      await redis.del(mine, theirs);
    }
  });

  it('does nothing for an id that is not a number (no pattern from a request)', async () => {
    await redis.set(keys.deckB, '1', 'EX', 60);
    await cache.forgetUser('*');
    await cache.forgetUser('');
    expect(await redis.exists(keys.deckB)).toBe(1);
  });
});
