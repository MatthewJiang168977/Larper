import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorageService, type ThrottlerStorage } from '@nestjs/throttler';
import { rateLimited, rateLimitStorageErrors } from '../metrics/metrics';
import { FailOpenStorage } from './fail-open.storage';
import { LIMITS } from './limits';
import { hit, limitTestApp, statuses } from './test-app';

// The limits as the real controllers declare them, counted in memory (the Redis
// storage has its own spec, throttle.redis.spec.ts). Every test uses its own users
// and client IPs, so counters never carry over.
let n = 0;
const fresh = (what: string) => `${what}-${++n}-${Date.now()}`;
const ipHeader = () => ({ 'x-forwarded-for': `203.0.113.${(n++ % 250) + 1}` });

const counter = async (c: typeof rateLimited | typeof rateLimitStorageErrors) =>
  (await c.get()).values.reduce((sum, v) => sum + v.value, 0);

describe('rate limits', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    ({ app, url } = await limitTestApp(new FailOpenStorage(new ThrottlerStorageService())));
  });
  afterAll(() => app.close());
  afterEach(() => {
    delete process.env.RATE_LIMIT_ENABLED;
    delete process.env.CLIENT_IP_SOURCE;
  });

  it('allows 6 check-ins a minute per user, then answers 429 with Retry-After', async () => {
    const user = fresh('u');
    const headers = ipHeader();
    const complete = () => hit(url, '/quests/1/complete', { user, method: 'POST', headers });
    expect(await statuses(LIMITS.checkIn.minute, complete)).toEqual(Array(6).fill(201));

    const before = await counter(rateLimited);
    const res = await complete();
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(50);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(await res.json()).toEqual({
      statusCode: 429,
      code: 'rate_limited',
      message: `Too many requests. Try again in ${retryAfter} s.`,
      retryAfterS: retryAfter,
    });
    expect(await counter(rateLimited)).toBe(before + 1);
  });

  it('counts each action separately, and each user separately', async () => {
    const user = fresh('u');
    const headers = ipHeader();
    const act = (action: string, who = user) => hit(url, `/quests/1/${action}`, { user: who, method: 'POST', headers });
    await statuses(LIMITS.checkIn.minute + 1, () => act('complete'));
    expect((await act('complete')).status).toBe(429);
    expect((await act('accept')).status).toBe(201); // its own counter, 30/min
    expect((await act('complete', fresh('other'))).status).toBe(201);
  });

  it('allows accept and skip 30 a minute', async () => {
    const user = fresh('u');
    const headers = ipHeader();
    const skip = () => hit(url, '/quests/1/skip', { user, method: 'POST', headers });
    const got = await statuses(LIMITS.questAction.minute + 1, skip);
    expect(got.slice(0, -1).every((s) => s === 201)).toBe(true);
    expect(got.at(-1)).toBe(429);
  });

  it("lets the survey poll through, but not a burst: today's quests 20 per 10 s", async () => {
    const user = fresh('u');
    const headers = ipHeader();
    const today = () => hit(url, '/quests/today?lat=40.73&lng=-73.99', { user, headers });
    const got = await statuses(LIMITS.questsToday.tenSeconds + 1, today);
    expect(got.slice(0, -1).every((s) => s === 200)).toBe(true);
    const res = await today();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeLessThanOrEqual(10);
  });

  it('gives other routes the default 30 a minute', async () => {
    const user = fresh('u');
    const headers = ipHeader();
    const got = await statuses(LIMITS.user.limit + 1, () => hit(url, '/quests', { user, headers }));
    expect(got.at(-2)).toBe(200);
    expect(got.at(-1)).toBe(429);
  });

  it('limits each IP before authentication, so bad tokens count, but never the probes', async () => {
    const headers = ipHeader();
    const anon = () => hit(url, '/quests/today', { headers }); // no user: 401 until the limit
    const got = await statuses(LIMITS.ip.limit, anon);
    expect(got.every((s) => s === 401)).toBe(true);
    expect((await anon()).status).toBe(429);
    expect((await hit(url, '/quests', { user: fresh('u'), headers })).status).toBe(429); // any route
    expect((await hit(url, '/healthz', { headers })).status).toBe(200);
    expect((await hit(url, '/readyz', { headers })).status).toBe(200);
    expect((await hit(url, '/quests/today', { headers: ipHeader() })).status).toBe(401); // another IP
  });

  describe('client IP', () => {
    // Exhaust one address's limit, then see which address a request is counted under.
    const exhaust = async (ip: string) => {
      const headers = { 'x-forwarded-for': ip };
      await statuses(LIMITS.ip.limit, () => hit(url, '/quests', { headers }));
    };

    it('uses X-Forwarded-For, as far as TRUST_PROXY allows (one hop here)', async () => {
      await exhaust('198.51.100.7');
      expect((await hit(url, '/quests', { headers: { 'x-forwarded-for': '198.51.100.7' } })).status).toBe(429);
      // A client can prepend whatever it likes; only the address the proxy added counts.
      const spoof = { 'x-forwarded-for': '10.9.9.9, 198.51.100.7' };
      expect((await hit(url, '/quests', { headers: spoof })).status).toBe(429);
    });

    it('ignores CF-Connecting-IP unless CLIENT_IP_SOURCE=cloudflare', async () => {
      await exhaust('198.51.100.8');
      const headers = { 'x-forwarded-for': '198.51.100.8', 'cf-connecting-ip': '192.0.2.44' };
      expect((await hit(url, '/quests', { headers })).status).toBe(429);
      process.env.CLIENT_IP_SOURCE = 'cloudflare';
      expect((await hit(url, '/quests', { headers })).status).toBe(401); // counted as 192.0.2.44
    });
  });

  it('turns off with RATE_LIMIT_ENABLED=0', async () => {
    process.env.RATE_LIMIT_ENABLED = '0';
    const user = fresh('u');
    const got = await statuses(LIMITS.checkIn.minute + 3, () =>
      hit(url, '/quests/1/complete', { user, method: 'POST', headers: ipHeader() }),
    );
    expect(got.every((s) => s === 201)).toBe(true);
  });
});

describe('when the limit store fails', () => {
  let app: INestApplication;
  let url: string;
  const broken: ThrottlerStorage = {
    increment: async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    },
  };

  beforeAll(async () => {
    ({ app, url } = await limitTestApp(new FailOpenStorage(broken)));
  });
  afterAll(() => app.close());

  it('lets every request through and counts it', async () => {
    const before = await counter(rateLimitStorageErrors);
    const user = fresh('u');
    const got = await statuses(LIMITS.checkIn.minute + 2, () =>
      hit(url, '/quests/1/complete', { user, method: 'POST', headers: ipHeader() }),
    );
    expect(got.every((s) => s === 201)).toBe(true);
    // Three checks per check-in: the IP's, then the user's per-minute and hourly windows.
    expect(await counter(rateLimitStorageErrors)).toBe(before + got.length * 3);
  });
});
