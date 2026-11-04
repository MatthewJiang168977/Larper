import { DATA_COLLECTION, sentryOptions, tracesSampler } from './instrument';

const ctx = (name: string, url?: string, method?: string) => ({
  name,
  normalizedRequest: url || method ? { url, method } : undefined,
  inheritOrSampleWith: (rate: number) => rate,
});

describe('tracesSampler', () => {
  it.each([
    ['GET /readyz', '/readyz'],
    ['GET /healthz', '/healthz'],
    ['GET /metrics', undefined],
    ['GET', 'http://10.42.0.7:3000/readyz'],
  ])('never traces health checks and metrics (%s)', (name, url) => {
    expect(tracesSampler(ctx(name, url), 0.1)).toBe(0);
  });

  it('never traces CORS preflights', () => {
    expect(tracesSampler(ctx('OPTIONS /quests/today', '/quests/today', 'OPTIONS'), 0.1)).toBe(0);
  });

  it('samples everything else at the rate, or as the incoming trace decided', () => {
    expect(tracesSampler(ctx('GET /quests/today', '/quests/today?lat=1&lng=2', 'GET'), 0.1)).toBe(0.1);
    const inherited = { ...ctx('POST /quests/:id/:action'), inheritOrSampleWith: () => 1 };
    expect(tracesSampler(inherited, 0.1)).toBe(1);
  });
});

describe('sentryOptions', () => {
  it('is off without a DSN', () => {
    expect(sentryOptions({}).enabled).toBe(false);
  });

  it('takes the DSN, release and environment from the environment', () => {
    const o = sentryOptions({ SENTRY_DSN: 'https://k@o1.ingest.us.sentry.io/2', SENTRY_RELEASE: 'abc1234', SENTRY_ENVIRONMENT: 'oci' });
    expect(o).toMatchObject({ enabled: true, release: 'abc1234', environment: 'oci' });
  });

  it('collects no user, cookies, headers, bodies, query, SQL parameters or frame variables', () => {
    expect(sentryOptions({}).dataCollection).toBe(DATA_COLLECTION);
    expect(DATA_COLLECTION).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    });
  });
});
