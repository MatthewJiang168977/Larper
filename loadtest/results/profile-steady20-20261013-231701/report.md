# Cache + CPU profile: profile-steady20-20261013-231701

API resources: {"limits":{"memory":"256Mi"},"requests":{"cpu":"300m","memory":"128Mi"}}. Profiled pod: api-f89d9d65b-gv4t8.
k6: p50 23 ms, p95 64 ms.

## Cache hit rate

`area` is only looked up on a `deck` miss (it feeds ranking), so its rate is among deck misses.

**Whole run**

| Cache | Lookups | Hit | Miss | Error | Hit rate |
|---|---|---|---|---|---|
| area | 50 | 49 | 1 | 0 | 98.0% |
| deck | 4557 | 4507 | 50 | 0 | 98.9% |

**Warm (after the warmup)**

| Cache | Lookups | Hit | Miss | Error | Hit rate |
|---|---|---|---|---|---|
| area | 1 | 1 | 0 | 0 | 100.0% |
| deck | 2914 | 2913 | 1 | 0 | 100.0% |

## CPU profile (main thread)

60 s profiled, 50379 samples. Busy 15.9% of the time (≈ 159m of one core; GC and libuv threads not included).

**Self time by area**

| Area | Share of busy time |
|---|---|
| (garbage collector) | 25.5% |
| app: quests/scoring.js | 19.5% |
| node core | 13.8% |
| (program) | 10.1% |
| (native / V8 builtins) | 8.7% |
| app: cache/cache.service.js | 7.8% |
| app: quests/quests.service.js | 3.0% |
| pg | 1.7% |
| jose | 1.6% |
| express | 1.3% |
| pg-protocol | 1.0% |
| @nestjs/core | 0.8% |
| pg-pool | 0.8% |
| @nestjs/common | 0.6% |
| ioredis | 0.6% |

**Top functions by self time**

| Function | Share of busy time |
|---|---|
| (garbage collector) — (garbage collector) | 25.5% |
| jaccard — app: quests/scoring.js:72 | 11.7% |
| (program) — (program) | 10.1% |
| getOrSet — app: cache/cache.service.js:34 | 7.8% |
| mmr — app: quests/scoring.js:81 | 6.8% |
| writev — (native / V8 builtins) | 5.3% |
| today — app: quests/quests.service.js:54 | 2.7% |
| slice — node core:640 | 2.0% |
| deprecate — node core:175 | 1.4% |
| writeUtf8String — (native / V8 builtins) | 0.9% |
| (anonymous) — app: quests/scoring.js:74 | 0.9% |
| nextTick — node core:111 | 0.8% |
| addFields — pg:82 | 0.7% |
| runMicrotasks — (native / V8 builtins) | 0.6% |
| emit — node core:466 | 0.5% |
| (anonymous) — (native / V8 builtins) | 0.5% |
| stringify — express:1029 | 0.4% |
| validateClaimsSet — jose:53 | 0.4% |
| processTimers — node core:506 | 0.3% |
| decodeBase64 — jose:47 | 0.3% |
| run — (native / V8 builtins) | 0.3% |
| handle — express:152 | 0.3% |
| observerCallback — node core:530 | 0.2% |
| processTicksAndRejections — node core:71 | 0.2% |
| _pulseQueue — pg-pool:127 | 0.2% |

**App functions by inclusive time** (including everything they call)

| Function | Share of busy time |
|---|---|
| today — app: quests/quests.service.js | 24.1% |
| mmr — app: quests/scoring.js | 19.5% |
| (anonymous) — app: quests/scoring.js | 12.6% |
| jaccard — app: quests/scoring.js | 12.6% |
| getOrSet — app: cache/cache.service.js | 10.2% |
| parse — pg-protocol | 3.4% |
| (anonymous) — pg-protocol | 3.0% |
| verifySignature — jose | 1.9% |
| httpMetrics — app: metrics/metrics.js | 1.6% |
| jwtVerify — jose | 1.2% |
| canActivate — app: auth/auth.guard.js | 1.1% |
| (anonymous) — app: auth/clerk-verifier.js | 0.8% |
| verifyCompact — jose | 0.7% |
| handlePacket — pg-protocol | 0.6% |
| validateClaimsSet — jose | 0.4% |
| parseJoseHeader — jose | 0.4% |
| parseProtectedHeader — jose | 0.4% |
| decodeBase64 — jose | 0.4% |
| bind — pg-protocol | 0.4% |
| active — app: quests/quests.service.js | 0.3% |

Requests (all VUs, whole run): 4697 at 19.2 req/s.
