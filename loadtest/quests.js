// Load test for GET /quests/today: the full request path (JWT verify, Redis, PostGIS
// + pgvector ranking). Goal: push the api past its 70% CPU target and watch the HPA
// scale it from 2 to 4+ replicas while p95 stays sane.
//
//   CLERK_SECRET_KEY=sk_test_... k6 run loadtest/quests.js
//   BASE_URL=http://<aks-ip> USERS=10 PEAK_VUS=200 k6 run loadtest/quests.js
//
// Auth is real: setup() makes a pool of test users on the Clerk dev instance (once;
// they're reused across runs) and opens a session for each through the Backend API.
// The secret key stays on the machine running k6 and never enters the cluster.
// Session tokens live 60 s, so each VU re-mints its own before it expires.
import http from 'k6/http';
import { check, fail, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const CLERK = 'https://api.clerk.com/v1';
const SECRET = __ENV.CLERK_SECRET_KEY;
const USERS = Number(__ENV.USERS || 10);
const PEAK = Number(__ENV.PEAK_VUS || 200);
const TOKEN_TTL_MS = 45_000; // re-mint well before Clerk's 60 s expiry
// Each VU waits THINK_S + up to 1 s between requests. The default (~1 req/s) is right at
// the API's per-user limit; THINK_S=1 stays under every limit (loadtest/rate-limit.js).
const THINK_S = Number(__ENV.THINK_S || 0.5);

// Spread over NYC, which is fully ingested: no request here should trigger an
// ingest job. Each test user stays near one home spot, like a person walking around
// (teleporting more than 5 km expires their offer on every request, which measures
// write churn instead). The jitter crosses geohash6 cells, so some requests miss the
// deck cache and the test measures ranking, not only Redis.
const SPOTS = [
  [40.7295, -73.9965], // Washington Sq
  [40.7265, -73.9815], // East Village
  [40.7183, -73.9584], // Williamsburg edge
  [40.7411, -74.0048], // Meatpacking
  [40.7614, -73.9776], // Midtown
  [40.7831, -73.9712], // UWS
  [40.7158, -73.9970], // Chinatown
  [40.8075, -73.9626], // Morningside
];

// SCENARIO=ramp (default): scale-out test. SCENARIO=steady: constant load for the
// failure test (loadtest/chaos.sh kills pods while it runs; VUS, DURATION).
// SCENARIO=cold: the cache-miss test (loadtest/cold-run.sh). Users come from their own
// onboarded pool (loadtest-cold+N, COLD_USERS of them: Clerk dev instances stop at
// 100 users), VU i plays user i % COLD_USERS, and requests go to the populated cells
// in CELLS (from loadtest/cold-cells.js, path relative to this file). A deck is
// cached per user, taste version and cell for 10 min, so a request in a cell the user
// hasn't visited since their taste last changed is a miss:
//   COLD_MODE=home (default): each user has a home cell (the ones with the most
//     cells within 4.9 km). Its VUs start at the home center, where the offer is
//     made, then split the cells within 4.9 km and visit their share once each in
//     random order. Staying within 5 km of the offer, it never goes stale. A VU that
//     has walked its share re-posts the user's onboarding answers (same taste, new
//     version, so every key is new) and walks again: a clean miss.
//   COLD_MODE=relocate: each request in a random cell anywhere in the city. Every
//     request also expires the last offer and makes a new one (offer churn).
const COLD = (__ENV.SCENARIO || 'ramp') === 'cold';
const COLD_MODE = __ENV.COLD_MODE || 'home';
const COLD_USERS = Number(__ENV.COLD_USERS || 50);
const CELLS = COLD ? JSON.parse(open(__ENV.CELLS)) : null;
const HOMES = COLD
  ? CELLS.near.map((n, i) => [n.length, i]).sort((a, b) => b[0] - a[0]).slice(0, COLD_USERS).map(([, i]) => i)
  : null;

const SCENARIOS = {
  ramp: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '1m', target: PEAK / 4 },
      { duration: '2m', target: PEAK },
      { duration: '4m', target: PEAK }, // hold: the HPA reacts in ~15 s steps, pods need ~20 s to be ready
      { duration: '1m', target: 0 },
    ],
    gracefulRampDown: '10s',
  },
  // Sizing: hold each load level with the HPA off, to read CPU per pod at a known
  // request rate and find where p95 degrades (loadtest/hpa-run.sh sizing).
  // STEPS=20,40,60 (VUs), STEP_HOLD=90s.
  steps: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: (__ENV.STEPS || '20,40,60,80,100').split(',').map(Number).flatMap((v) => [
      { duration: '10s', target: v },
      { duration: __ENV.STEP_HOLD || '90s', target: v },
    ]),
    gracefulRampDown: '10s',
  },
  cold: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '1m', target: PEAK },
      { duration: __ENV.HOLD || '3m', target: PEAK },
      { duration: '30s', target: 0 },
    ],
    gracefulRampDown: '10s',
  },
  steady: {
    executor: 'constant-vus',
    vus: Number(__ENV.VUS || 60),
    duration: __ENV.DURATION || '7m',
  },
};
const SCENARIO = __ENV.SCENARIO || 'ramp';

export const options = {
  scenarios: { [SCENARIO]: SCENARIOS[SCENARIO] },
  setupTimeout: '10m',
  thresholds: {
    'http_req_failed{name:today}': ['rate<0.01'],
    'http_req_duration{name:today}': ['p(95)<800'],
  },
};

function clerk(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = http.request(method, `${CLERK}${path}`, body ? JSON.stringify(body) : null, {
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      tags: { name: 'clerk' },
    });
    // Setting up 100 users runs into Clerk's Backend API rate limit; wait it out.
    if (res.status === 429 && attempt < 10) {
      sleep(Number(res.headers['Retry-After'] || 2));
      continue;
    }
    if (res.status >= 300) fail(`clerk ${method} ${path}: ${res.status} ${res.body}`);
    return res.json();
  }
}

export function setup() {
  if (!SECRET) fail('set CLERK_SECRET_KEY (the dev instance secret, from apps/web/.env.local)');
  const n = COLD ? COLD_USERS : USERS;
  const sessions = [];
  let cards = null;
  for (let i = 0; i < n; i++) {
    const email = COLD ? `loadtest-cold+${i}@example.com` : `loadtest+${i}@example.com`;
    const found = clerk('GET', `/users?email_address=${encodeURIComponent(email)}`);
    const user = found.length
      ? found[0]
      : clerk('POST', '/users', { email_address: [email], skip_password_requirement: true });
    const session = clerk('POST', '/sessions', { user_id: user.id }).id;
    sessions.push(session);
    if (!COLD) continue;
    // Onboard, so ranking on a miss computes real taste similarity.
    const jwt = clerk('POST', `/sessions/${session}/tokens`).jwt;
    if (!cards) cards = http.get(`${BASE_URL}/onboarding/cards`, { headers: { Authorization: `Bearer ${jwt}` }, tags: { name: 'setup' } }).json().map((c) => c.id);
    onboard(jwt, cards, i, 'setup');
  }
  if (COLD && HOMES.length < COLD_USERS) console.warn(`only ${HOMES.length} home cells for ${COLD_USERS} users: some share one`);
  return { sessions, cards };
}

// Revoke the run's sessions, so the IDs in setup_data are dead even if a summary
// escapes redact.js.
export function teardown(data) {
  for (const session of data.sessions) clerk('POST', `/sessions/${session}/revoke`);
}

// The liked cards depend only on the user, so re-onboarding keeps the same taste
// and only moves its version.
function onboard(jwt, cards, i, name) {
  const liked = [...new Set([0, 1, 2].map((k) => cards[(i * 7 + k * 5) % cards.length]))];
  const res = http.post(`${BASE_URL}/onboarding`, JSON.stringify({ liked }), {
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    tags: { name },
  });
  if (res.status >= 300) fail(`onboarding user ${i}: ${res.status} ${res.body}`);
}

let token = null;
let mintedAt = 0;

// COLD_MODE=home: the cells this VU still has to visit before the next re-onboard.
let walk = null;

const shuffled = (xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const pointIn = ([s, w, n, e]) => [s + Math.random() * (n - s), w + Math.random() * (e - w)];

function coldStep(data, user) { // -> [lat, lng]
  if (COLD_MODE === 'relocate') return pointIn(CELLS.cells[Math.floor(Math.random() * CELLS.cells.length)]);
  const home = HOMES[user % HOMES.length];
  if (walk && !walk.length) onboard(token, data.cards, user, 'onboard'); // new taste version: all keys fresh
  if (!walk || !walk.length) {
    const share = Math.floor((__VU - 1) / COLD_USERS);
    const shares = Math.ceil(PEAK / COLD_USERS);
    const [s, w, n, e] = CELLS.cells[home];
    const mine = CELLS.near[home].filter((_, k) => k % shares === share);
    walk = [[(s + n) / 2, (w + e) / 2], ...shuffled(mine).map((c) => pointIn(CELLS.cells[c]))];
  }
  return walk.shift();
}

export default function (data) {
  const user = (__VU - 1) % data.sessions.length;
  if (!token || Date.now() - mintedAt > TOKEN_TTL_MS) {
    token = clerk('POST', `/sessions/${data.sessions[user]}/tokens`).jwt;
    mintedAt = Date.now();
  }

  let lat;
  let lng;
  if (COLD) {
    [lat, lng] = coldStep(data, user);
  } else {
    const jitter = () => (Math.random() - 0.5) * 0.008; // ~±400 m
    [lat, lng] = SPOTS[user % SPOTS.length];
    lat += jitter();
    lng += jitter();
  }
  const res = http.get(`${BASE_URL}/quests/today?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { name: 'today' },
  });
  check(res, { '200': (r) => r.status === 200 });
  sleep(THINK_S + Math.random());
}
