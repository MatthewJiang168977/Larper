import type { INestApplication } from '@nestjs/common';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { FailOpenStorage } from '../throttle/fail-open.storage';
import { limitTestApp } from '../throttle/test-app';

// POST /quests/:id/was-open through the real controller and guards (the service is a stub:
// see test-app.ts). The rules about whose quest and what state are in place-hours.db.spec.ts.
let n = 0;
const post = (url: string, path: string, body?: unknown, user: string | null = `wo-${++n}-${Date.now()}`) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      ...(user ? { 'x-test-user': user } : {}),
      'x-forwarded-for': `198.51.101.${(++n % 250) + 1}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('QuestsController: POST /quests/:id/was-open', () => {
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    ({ app, url } = await limitTestApp(new FailOpenStorage(new ThrottlerStorageService())));
  });
  afterAll(() => app.close());

  it('takes each of the three answers and answers 200 (not 201), not routed as an action called "was-open"', async () => {
    for (const answer of ['yes', 'no', 'didnt_check']) {
      const res = await post(url, '/quests/7/was-open', { answer });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ wasOpen: answer });
    }
  });

  it('refuses anything else with a 400 that names the choices', async () => {
    for (const body of [{ answer: 'maybe' }, { answer: 'YES' }, { answer: true }, { answer: null }, { answer: ['yes'] }, {}, undefined]) {
      const res = await post(url, '/quests/7/was-open', body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toBe('answer must be one of yes, no, didnt_check');
    }
  });

  it('refuses a quest id that is not a number', async () => {
    for (const id of ['abc', '1e3', '-1', '1.5', '%20']) {
      expect((await post(url, `/quests/${id}/was-open`, { answer: 'yes' })).status).toBe(400);
    }
  });

  it('needs a signed-in user', async () => {
    const res = await post(url, '/quests/7/was-open', { answer: 'yes' }, null);
    expect(res.status).toBe(401);
  });

  it('shares the quest-action limit per user: over it, 429', async () => {
    const user = `wo-limit-${Date.now()}`;
    const codes: number[] = [];
    for (let i = 0; i < 35; i++) codes.push((await post(url, '/quests/7/was-open', { answer: 'yes' }, user)).status);
    expect(codes.slice(0, 30)).toEqual(Array(30).fill(200));
    expect(codes.slice(30)).toContain(429);
  });
});
