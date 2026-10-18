import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { corsOptions } from './cors';
import { FailOpenStorage } from './throttle/fail-open.storage';
import { LIMITS } from './throttle/limits';
import { hit, limitTestApp, statuses } from './throttle/test-app';

const WEB = 'https://larper.vercel.app';

describe('corsOptions', () => {
  it('is off without CORS_ORIGINS', () => {
    expect(corsOptions({})).toBeNull();
    expect(corsOptions({ CORS_ORIGINS: ' , ' })).toBeNull();
  });

  it('refuses wildcards, paths and anything that is not an origin', () => {
    for (const bad of ['*', 'https://*.vercel.app', 'https://larper.app/', 'https://larper.app/api', 'larper.app']) {
      expect(() => corsOptions({ CORS_ORIGINS: bad })).toThrow('is not an origin');
    }
  });

  it('takes a list, and Max-Age from CORS_MAX_AGE_S', () => {
    expect(corsOptions({ CORS_ORIGINS: `${WEB}, http://localhost:3001`, CORS_MAX_AGE_S: '600' })).toMatchObject({
      origin: [WEB, 'http://localhost:3001'],
      credentials: false,
      maxAge: 600,
    });
  });
});

describe('CORS on the API', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    const cors = corsOptions({ CORS_ORIGINS: `${WEB},http://localhost:3001`, CORS_MAX_AGE_S: '7200' })!;
    ({ app, url } = await limitTestApp(new FailOpenStorage(new ThrottlerStorageService()), (a) => a.enableCors(cors)));
  });
  afterAll(() => app.close());

  const preflight = (origin: string) =>
    fetch(`${url}/quests/1/complete`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });

  it('answers a preflight from an allowed origin, cacheable for Max-Age, without credentials', async () => {
    const res = await preflight(WEB);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET,POST');
    expect(res.headers.get('access-control-allow-headers')).toBe('Authorization,Content-Type');
    expect(res.headers.get('access-control-max-age')).toBe('7200');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('gives any other origin nothing to go on', async () => {
    const res = await preflight('https://evil.example');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const get = await hit(url, '/quests', { user: 'cors-u1', headers: { Origin: 'https://larper.vercel.app.evil.example' } });
    expect(get.headers.get('access-control-allow-origin')).toBeNull();
  });

  it("doesn't count preflights against the rate limits", async () => {
    const got = await statuses(LIMITS.checkIn.minute + 5, () => preflight(WEB));
    expect(got.every((s) => s === 204)).toBe(true);
  });

  it("lets the web app read a 429's Retry-After", async () => {
    const headers = { Origin: WEB, 'x-forwarded-for': '203.0.113.200' };
    await statuses(LIMITS.checkIn.minute, () => hit(url, '/quests/1/complete', { user: 'cors-u2', method: 'POST', headers }));
    const res = await hit(url, '/quests/1/complete', { user: 'cors-u2', method: 'POST', headers });
    expect(res.status).toBe(429);
    expect(res.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(res.headers.get('access-control-expose-headers')).toBe('Retry-After');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
