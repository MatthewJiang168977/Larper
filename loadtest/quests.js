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
  // Sizing: hold each load level for 2 min with the HPA off, to read CPU per pod
  // at a known request rate (loadtest/hpa-run.sh sizing).
  steps: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [20, 40, 60, 80].flatMap((v) => [
      { duration: '10s', target: v },
      { duration: '2m', target: v },
    ]),
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
  thresholds: {
    'http_req_failed{name:today}': ['rate<0.01'],
    'http_req_duration{name:today}': ['p(95)<800'],
  },
};

function clerk(method, path, body) {
  const res = http.request(method, `${CLERK}${path}`, body ? JSON.stringify(body) : null, {
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    tags: { name: 'clerk' },
  });
  if (res.status >= 300) fail(`clerk ${method} ${path}: ${res.status} ${res.body}`);
  return res.json();
}

export function setup() {
  if (!SECRET) fail('set CLERK_SECRET_KEY (the dev instance secret, from apps/web/.env.local)');
  const sessions = [];
  for (let i = 0; i < USERS; i++) {
    const email = `loadtest+${i}@example.com`;
    const found = clerk('GET', `/users?email_address=${encodeURIComponent(email)}`);
    const user = found.length
      ? found[0]
      : clerk('POST', '/users', { email_address: [email], skip_password_requirement: true });
    sessions.push(clerk('POST', '/sessions', { user_id: user.id }).id);
  }
  return { sessions };
}

let token = null;
let mintedAt = 0;

export default function (data) {
  const user = (__VU - 1) % data.sessions.length;
  if (!token || Date.now() - mintedAt > TOKEN_TTL_MS) {
    token = clerk('POST', `/sessions/${data.sessions[user]}/tokens`).jwt;
    mintedAt = Date.now();
  }

  const [lat, lng] = SPOTS[user % SPOTS.length];
  const jitter = () => (Math.random() - 0.5) * 0.008; // ~±400 m
  const res = http.get(`${BASE_URL}/quests/today?lat=${(lat + jitter()).toFixed(5)}&lng=${(lng + jitter()).toFixed(5)}`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { name: 'today' },
  });
  check(res, { '200': (r) => r.status === 200 });
  sleep(0.5 + Math.random());
}
