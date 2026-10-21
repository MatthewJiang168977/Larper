# 0004: Rate limits per client IP and per user, counted in Redis

- **Status:** accepted, 2026-10-18
- **Scope:** `apps/api/src/throttle/`, the controllers' limit decorators, `api.rateLimit`
  in `infra/helm/larper`, the web app's handling of 429
- **Evidence:** `loadtest/results/ratelimit-cost-*`, `loadtest/results/rate-limit-*` (k3d)

## Context

The API had no request limits. Every route behind Clerk could be called as fast as a
client liked, including check-in, which takes a reported position: a script can walk a
fake position around a place until it's accepted. Unauthenticated requests cost a JWT
verification each.

## Decision

`@nestjs/throttler` 6 with its Redis storage (`@nest-lab/throttler-storage-redis`), so a
limit holds across API replicas. Two guards, both subclasses of the library's guard:

- **Per IP** (`IpLimitGuard`, an `APP_GUARD`, so before authentication): 600 a minute
  across all routes. Requests with a bad or missing token count. The probes are exempt,
  since the kubelet's would all count against the node's address. It's generous
  because one IP can be a household or a carrier's NAT; it's for floods and token
  guessing.
- **Per user** (`UserLimitGuard`, after `ClerkAuthGuard`), keyed by our user id, per
  route:

| Route | Limit |
|---|---|
| `POST /quests/:id/complete` (check-in) | 6 a minute and 30 an hour |
| `POST /quests/:id/accept`, `/skip`, `/not-today`, `/reason` | 30 a minute (each action its own counter) |
| `GET /quests/today` | 60 a minute and 20 per 10 s (the survey poll is 15 a minute) |
| `POST /onboarding` | 10 a minute |
| everything else (`/me`, `/onboarding/cards`, the journal) | 30 a minute |

Windows are fixed: a counter per key that expires after the window. A key over its
limit is refused for one window from then.

The 429 carries `Retry-After` (seconds) and a body of
`{ code: "rate_limited", message: "Too many requests. Try again in N s.", retryAfterS }`.
The library sets only `Retry-After-<name>` for named limits, so the guards set the plain
header themselves. The web app shows the message, and its survey poll waits
`retryAfterS` instead of 4 s. It reads the wait from the body first, because a browser
hides a cross-origin `Retry-After` unless the API exposes it.

`limits.ts` holds every number.

### Redis down: fail open

A limit check that can't reach Redis lets the request through. It counts the miss in
`rate_limit_storage_errors_total{throttler}` and logs at most every 10 s. The client
doesn't queue commands while disconnected and gives up after 250 ms. Otherwise a Redis
restart would refuse every request, for a limit that only exists to stop abuse.

The same applies for a moment after a pod starts, before its Redis connection is up.
Alert on the counter being non-zero for more than a few minutes.

### Evictions reset counters, accepted

Redis runs with `maxmemory 128mb` and `allkeys-lru`, shared with the deck cache. Under
memory pressure it may evict a limit's counter, which resets that key's count early.

The keys are tiny and live at most an hour, and an eviction only ever lets a client
through, never blocks one. A separate Redis, or `volatile-lru` with TTLs on the cache
keys, would avoid it if it ever matters.

### Client IP

`api.rateLimit.clientIp` sets where the address comes from:

- **`forwarded`** (default; k3d, AKS, EKS): `req.ip`, which Express takes from
  `X-Forwarded-For` as far back as `api.rateLimit.trustProxy` allows. That's a hop count
  (1 for Traefik; k3d's load balancer passes TCP through) or the proxies' CIDRs. A
  client can prepend anything to `X-Forwarded-For`; only the entry the trusted proxy
  added counts.
- **`cloudflare`** (OCI, where public traffic is to come through a Cloudflare Tunnel):
  `CF-Connecting-IP`, which Cloudflare's edge sets and a client can't override through
  Cloudflare.
  - It's believed only when the socket peer is a proxy that `trustProxy` trusts, the
    ingress or the tunnel. Anything else could have set the header itself.
  - With a hop count, any peer counts as the proxy. To make it strict, set `trustProxy`
    to the ingress pods' CIDR.
  - A request without the header (an admin through the SSH tunnel) falls back to
    `forwarded`.

The browser calls the API directly, so the address the API sees is the visitor's.

- **The web app** (on Vercel in production) calls `NEXT_PUBLIC_API_URL` cross-origin.
- **The API** allows that origin with CORS: `api.cors.origins`, exact origins and no
  wildcard, each also a Clerk authorized party.
- **The old `/api` rewrite** survives only under `next dev`, when the variable is unset.
  A production build without the variable fails.
- **Why not proxy through Next:** it would put every visitor behind Vercel's addresses,
  one client as far as the per-IP limit is concerned. It would also add a second public
  path to the API.

### Off switch

`api.rateLimit.enabled=false` (env `RATE_LIMIT_ENABLED=0`) turns every limit off. Load
tests need it: they drive one user at ~1 req/s and every VU from one IP. CI checks that
every values profile ships it on.

## Cost

**The library.** The Redis storage sends one Lua script per limit window per request
(`INCR`, `PTTL`, and a block key once over), with `EVAL` and the script's source each
time, not `EVALSHA`. The guard checks windows one after another, so:

- A check-in is 3 round trips (IP, minute, hour).
- `GET /quests/today` is 3 (IP, 10 s, minute).
- Other routes are 2.

`throttle.redis.spec.ts` checks these counts against Redis's own command stats.

**Measured on k3d.** Steady load of 9 VUs, one user each, ~40 requests a minute (under
every limit, so nothing was refused), ~5.7 req/s, 3 minutes per run, about 1,050
requests to `/quests/today` each:

| Run | Limiter | `/quests/today` median | p95 |
|---|---|---|---|
| before | not in the image | 37.2 ms | 62.4 ms |
| after | on | 43.8 ms | 66.9 ms |
| same image | off | 27.5 ms | 59.0 ms |
| same image | on | 28.2 ms | 58.8 ms |

Run-to-run noise (the first two rows against the last two) is larger than the
limiter's effect. Back to back on the same image it adds about 1 ms to the median and
nothing measurable to p95.

## Consequences

- **A new route gets 30 per user per minute** unless it sets its own limit with
  `@Throttle`. It's under the per-IP limit unless it skips it.
- **One machine running `loadtest/rate-limit.js`** exhausts its address for a minute.
  Every local client behind Traefik shares that address.
- **Local dev through the proxy:** with `next dev` and no `NEXT_PUBLIC_API_URL`, every
  local browser shares the dev server's address for the per-IP limit. That's harmless
  for one developer.
