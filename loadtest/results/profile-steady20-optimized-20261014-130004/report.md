# Cache + CPU profile: profile-steady20-optimized-20261014-130004

API resources: {"limits":{"memory":"256Mi"},"requests":{"cpu":"300m","memory":"128Mi"}}. Profiled pod: api-75c98f494d-8jc4k.
k6: p50 17 ms, p95 45 ms.

## Cache hit rate

`area` is only looked up on a `deck` miss (it feeds ranking), so its rate is among deck misses.

**Whole run**

| Cache | Lookups | Hit | Miss | Error | Hit rate |
|---|---|---|---|---|---|
| area | 51 | 15 | 36 | 0 | 29.4% |
| deck | 4656 | 4605 | 51 | 0 | 98.9% |

**Warm (after the warmup)**

| Cache | Lookups | Hit | Miss | Error | Hit rate |
|---|---|---|---|---|---|
| area | 2 | 2 | 0 | 0 | 100.0% |
| deck | 3016 | 3014 | 2 | 0 | 99.9% |

## CPU profile (main thread)

60 s profiled, 50546 samples. Busy 13.5% of the time (≈ 135m of one core; GC and libuv threads not included).

**Self time by area**

| Area | Share of busy time |
|---|---|
| (garbage collector) | 21.2% |
| node core | 18.8% |
| (native / V8 builtins) | 14.5% |
| (program) | 12.5% |
| app: cache/cache.service.js | 9.4% |
| app: quests/scoring.js | 4.8% |
| pg | 2.9% |
| jose | 2.4% |
| express | 1.9% |
| pg-protocol | 1.7% |
| pg-pool | 1.6% |
| app: quests/quests.service.js | 1.6% |
| router | 1.1% |
| prom-client | 0.9% |
| @nestjs/core | 0.8% |

**Top functions by self time**

| Function | Share of busy time |
|---|---|
| (garbage collector) — (garbage collector) | 21.2% |
| (program) — (program) | 12.5% |
| getOrSet — app: cache/cache.service.js:34 | 9.4% |
| writev — (native / V8 builtins) | 9.3% |
| jaccard — app: quests/scoring.js:72 | 3.3% |
| slice — node core:640 | 2.7% |
| mmr — app: quests/scoring.js:81 | 1.2% |
| writeUtf8String — (native / V8 builtins) | 1.2% |
| runMicrotasks — (native / V8 builtins) | 1.1% |
| nextTick — node core:111 | 1.0% |
| addFields — pg:82 | 1.0% |
| today — app: quests/quests.service.js:54 | 0.9% |
| (anonymous) — (native / V8 builtins) | 0.9% |
| deprecate — node core:175 | 0.7% |
| emit — node core:466 | 0.6% |
| stringify — express:1029 | 0.6% |
| processTicksAndRejections — node core:71 | 0.5% |
| onStreamRead — node core:166 | 0.5% |
| parseRow — pg:63 | 0.5% |
| decodeBase64 — jose:47 | 0.5% |
| run — (native / V8 builtins) | 0.4% |
| verifySignature — jose:42 | 0.4% |
| (anonymous) — pg-pool:449 | 0.4% |
| handle — express:152 | 0.4% |
| next — router:188 | 0.4% |

**App functions by inclusive time** (including everything they call)

| Function | Share of busy time |
|---|---|
| getOrSet — app: cache/cache.service.js | 11.8% |
| today — app: quests/quests.service.js | 9.5% |
| parse — pg-protocol | 5.5% |
| (anonymous) — pg-protocol | 4.9% |
| mmr — app: quests/scoring.js | 4.8% |
| verifySignature — jose | 3.6% |
| jaccard — app: quests/scoring.js | 3.6% |
| httpMetrics — app: metrics/metrics.js | 2.8% |
| jwtVerify — jose | 1.9% |
| canActivate — app: auth/auth.guard.js | 1.9% |
| (anonymous) — app: auth/clerk-verifier.js | 1.4% |
| verifyCompact — jose | 1.3% |
| handlePacket — pg-protocol | 0.9% |
| decode — jose | 0.7% |
| decodeBase64 — jose | 0.7% |
| parseProtectedHeader — jose | 0.7% |
| parseJoseHeader — jose | 0.6% |
| (anonymous) — app: metrics/metrics.js | 0.6% |
| active — app: quests/quests.service.js | 0.5% |
| bind — pg-protocol | 0.5% |

Requests (all VUs, whole run): 4796 at 19.7 req/s.
