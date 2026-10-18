import type { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { rateLimitStorageErrors } from '../metrics/metrics';
import { LIMITS } from './limits';
import { hit, limitTestApp, statuses } from './test-app';

// The limits against a real Redis, as deployed: counters shared by every API replica,
// one Lua script per limit window per request, and requests let through when Redis is
// gone. Skipped unless TEST_REDIS_URL is set (CI's db job runs a Redis service).
const REDIS_URL = process.env.TEST_REDIS_URL;
const describeRedis = REDIS_URL ? describe : describe.skip;

const fresh = (what: string) => `${what}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const storageErrors = async () => (await rateLimitStorageErrors.get()).values.reduce((s, v) => s + v.value, 0);

// A new replica's Redis connection takes a moment, and until it's up the limiter fails
// open (it doesn't queue commands). Wait until a request is counted.
async function untilConnected(url: string) {
  for (let i = 0; i < 100; i++) {
    const before = await storageErrors();
    await (await hit(url, '/quests')).arrayBuffer();
    if ((await storageErrors()) === before) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${url} never reached Redis`);
}
const evalCalls = async (redis: Redis) => {
  const stats = await redis.info('commandstats');
  return Number(/cmdstat_eval:calls=(\d+)/.exec(stats)?.[1] ?? 0);
};

describeRedis('rate limits in Redis', () => {
  const apps: INestApplication[] = [];
  let a: string;
  let b: string;
  let redis: Redis;

  beforeAll(async () => {
    process.env.REDIS_URL = REDIS_URL;
    apps.push((await limitTestApp()).app, (await limitTestApp()).app);
    [a, b] = await Promise.all(apps.map((app) => app.getUrl()));
    await Promise.all([a, b].map(untilConnected));
    redis = new Redis(REDIS_URL!);
  });
  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    redis.disconnect();
    delete process.env.REDIS_URL;
  });

  it('holds across replicas: check-ins on two API instances share one count', async () => {
    const user = fresh('u');
    const complete = (url: string) => () => hit(url, '/quests/1/complete', { user, method: 'POST' });
    expect(await statuses(3, complete(a))).toEqual([201, 201, 201]);
    expect(await statuses(3, complete(b))).toEqual([201, 201, 201]);
    const res = await complete(a)();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(50);
    expect((await complete(b)()).status).toBe(429);
  });

  it('runs one Lua script per limit window per request, and the counters expire', async () => {
    const user = fresh('u');
    const before = await evalCalls(redis);
    await statuses(5, () => hit(a, '/quests', { user })); // IP + the user's minute window
    await statuses(5, () => hit(a, '/quests/1/complete', { user, method: 'POST' })); // + the hourly one
    expect((await evalCalls(redis)) - before).toBe(5 * 2 + 5 * 3);

    const keys = await redis.keys(`{rl:user:QuestsController.log:${user}:user}:*`);
    expect(keys).toHaveLength(1);
    const ttl = await redis.pttl(keys[0]);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(LIMITS.user.ttl);
  });
});

describeRedis('rate limits with Redis unreachable', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1'; // nothing listens there
    ({ app, url } = await limitTestApp());
  });
  afterAll(async () => {
    await app.close();
    delete process.env.REDIS_URL;
  });

  it('lets requests through, quickly, and counts each unchecked limit', async () => {
    const before = await storageErrors();
    const user = fresh('u');
    const start = Date.now();
    const got = await statuses(LIMITS.checkIn.minute + 2, () => hit(url, '/quests/1/complete', { user, method: 'POST' }));
    expect(got.every((s) => s === 201)).toBe(true);
    expect((Date.now() - start) / got.length).toBeLessThan(250); // no waiting on Redis
    expect((await storageErrors()) - before).toBe(got.length * 3);
  });
});
