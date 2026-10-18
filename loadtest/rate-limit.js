// The rate limits on a running stack, with limits on (api.rateLimit.enabled, the default):
// pushes one user and one client IP past each limit and checks the API answers 429
// with Retry-After (and the same wait in the body), and that the probes never are.
//
//   CLERK_SECRET_KEY=sk_test_... k6 run loadtest/rate-limit.js
//   BASE_URL=http://localhost:8080 k6 run loadtest/rate-limit.js
//
// The limits are apps/api/src/throttle/limits.ts. Run it alone: the per-IP part
// exhausts this machine's address for a minute (behind Traefik on k3d, every local
// client shares one), so anything else hitting the API from here gets 429s too.
//
// Auth as in quests.js: one Clerk dev-instance test user (loadtest+0, created if
// missing), one session, revoked in teardown.
import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const CLERK = 'https://api.clerk.com/v1';
const SECRET = __ENV.CLERK_SECRET_KEY;

// Limits under test (limits.ts).
const TODAY_PER_10S = 20;
const CHECKIN_PER_MIN = 6;
const IP_PER_MIN = 600;

const limited = new Counter('rate_limited');

export const options = {
  scenarios: {
    // One user polling today's quests far faster than the app does: 20 per 10 s, then 429.
    burst: { executor: 'per-vu-iterations', vus: 1, iterations: 1, exec: 'burst', startTime: '0s' },
    // Check-ins: 6 a minute, then 429.
    checkin: { executor: 'per-vu-iterations', vus: 1, iterations: 1, exec: 'checkIn', startTime: '15s' },
    // Unauthenticated requests from one IP: 600 a minute (401s until then), then 429,
    // while /healthz keeps answering.
    ip: { executor: 'per-vu-iterations', vus: 1, iterations: 1, exec: 'perIp', startTime: '30s' },
  },
  thresholds: {
    checks: ['rate==1.0'],
    rate_limited: ['count>=3'],
  },
};

function clerk(method, path, body) {
  const res = http.request(method, `${CLERK}${path}`, body ? JSON.stringify(body) : null, {
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    tags: { name: 'clerk' },
  });
  if (res.status >= 300) fail(`clerk ${method} ${path}: ${res.status}`);
  return res.json();
}

export function setup() {
  if (!SECRET) fail('set CLERK_SECRET_KEY (the dev instance secret, from apps/web/.env.local)');
  const email = 'loadtest+0@example.com';
  const found = clerk('GET', `/users?email_address=${encodeURIComponent(email)}`);
  const user = found.length ? found[0] : clerk('POST', '/users', { email_address: [email], skip_password_requirement: true });
  return { session: clerk('POST', '/sessions', { user_id: user.id }).id };
}

export function teardown(data) {
  clerk('POST', `/sessions/${data.session}/revoke`);
}

const token = (data) => clerk('POST', `/sessions/${data.session}/tokens`).jwt;

// A 429 as the API sends it: Retry-After in seconds, within the window, and the same
// number in the body with the "rate_limited" code.
function isLimited(res, windowS) {
  const retryAfter = Number(res.headers['Retry-After']);
  let body = {};
  try {
    body = res.json();
  } catch (_) {
    // checked below
  }
  const ok = check(res, {
    '429': (r) => r.status === 429,
    'Retry-After within the window': () => retryAfter >= 1 && retryAfter <= windowS,
    'body says rate_limited, with the same wait': () => body.code === 'rate_limited' && body.retryAfterS === retryAfter,
  });
  if (res.status === 429) limited.add(1);
  return ok;
}

// Sends until the first 429 (or `max` requests); returns [answers before it, the 429].
function untilLimited(send, max) {
  for (let i = 0; i < max; i++) {
    const res = send();
    if (res.status === 429) return [i, res];
  }
  return [max, null];
}

export function burst(data) {
  const auth = { headers: { Authorization: `Bearer ${token(data)}` }, tags: { name: 'today' } };
  const [ok, res] = untilLimited(() => http.get(`${BASE_URL}/quests/today?lat=40.7295&lng=-73.9965`, auth), 40);
  check(ok, { [`${TODAY_PER_10S} quests/today answered before the 429`]: (n) => n === TODAY_PER_10S });
  if (res) isLimited(res, 10);
}

export function checkIn(data) {
  const auth = { headers: { Authorization: `Bearer ${token(data)}`, 'Content-Type': 'application/json' }, tags: { name: 'checkin' } };
  // A quest id that doesn't exist: each attempt is a 404, but counts against the limit.
  const send = () => http.post(`${BASE_URL}/quests/999999999/complete`, JSON.stringify({ lat: 40.73, lng: -73.99 }), auth);
  const [ok, res] = untilLimited(send, 12);
  check(ok, { [`${CHECKIN_PER_MIN} check-ins answered before the 429`]: (n) => n === CHECKIN_PER_MIN });
  if (res) isLimited(res, 60);
}

export function perIp() {
  // This IP's count may already include the scenarios above, so expect the 429 at or
  // a little before the 600th request.
  const [ok, res] = untilLimited(() => http.get(`${BASE_URL}/quests/today`, { tags: { name: 'anon' } }), IP_PER_MIN + 10);
  check(ok, { 'about 600 unauthenticated requests answered before the 429': (n) => n > IP_PER_MIN - 100 && n <= IP_PER_MIN });
  if (res) isLimited(res, 60);
  const health = http.get(`${BASE_URL}/healthz`, { tags: { name: 'healthz' } });
  check(health, { 'probes are never limited': (r) => r.status === 200 });
  sleep(0.1);
}
