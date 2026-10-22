import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { FailOpenStorage } from '../throttle/fail-open.storage';
import { limitTestApp } from '../throttle/test-app';

// Routing and input checks for the quest actions, through the real controller (the
// service is a stub: see test-app.ts).
let n = 0;
const post = (url: string, path: string, body?: unknown) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'x-test-user': `ctl-${++n}-${Date.now()}`,
      'x-forwarded-for': `198.51.100.${(n % 250) + 1}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('QuestsController: Not today and its reasons', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    ({ app, url } = await limitTestApp(new FailOpenStorage(new ThrottlerStorageService())));
  });
  afterAll(() => app.close());

  it('takes not-today as an action', async () => {
    const res = await post(url, '/quests/7/not-today');
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: '7', status: 'not-today' });
  });

  it('routes /reason to the reason handler, not to an action called "reason"', async () => {
    const res = await post(url, '/quests/7/reason', { reason: 'too_far' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: '7', status: 'skipped', reason: 'too_far' });
  });

  it('accepts each of the four reasons, and nothing else', async () => {
    for (const reason of ['not_my_thing', 'too_far', 'not_today', 'closed']) {
      expect((await post(url, '/quests/7/reason', { reason })).status).toBe(201);
    }
    for (const body of [{ reason: 'boring' }, { reason: 'unstated' }, {}, undefined]) {
      const res = await post(url, '/quests/7/reason', body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toBe('reason must be one of not_my_thing, too_far, not_today, closed');
    }
  });

  it("refuses action names that are only on Object's prototype", async () => {
    for (const action of ['constructor', 'toString', '__proto__']) {
      expect((await post(url, `/quests/7/${action}`)).status).toBe(400);
    }
  });
});
