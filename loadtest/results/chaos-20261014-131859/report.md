# Failure test, 2026-10-14 17:19 UTC

Steady load for 430 s: 23582 requests, 143 failed (0.61%).
Failed by status: 500 ×143.

| At | Killed | Requests (next 60 s) | Failed | User-visible error window | Ready again after |
|---|---|---|---|---|---|
| 60 s | api-69586d44f5-7gwww (force) | 3455 | 0 | — | 8s |
| 121 s | api-69586d44f5-7kzjv (graceful) | 3481 | 0 | — | 8s |
| 181 s | taste-worker-7568cc8d7d-4nhfz (force) | 60 | 0 | — | 3s |
| 182 s | ingest-worker-69947fff59-cdsm7 (force) | 60 | 0 | — | 2s |
| 183 s | outbox-relay-788bb59c7c-j4p4v (force) | 3344 | 0 | — | 3s |
| 241 s | redis-5bdc64d65d-2pdln (force) | 3288 | 0 | — | 4s |
| 301 s | pg-1 (force) | 3050 | 143 | 13 s | 13s |

Failures before the first kill (baseline): 0.

Healing after the load stopped:
- kafka-lag-zero after 0s
- outbox-drained after 1s
- all-deployments api=6/6 ingest-worker=2/2 outbox-relay=1/1 redis=1/1 taste-worker=2/2
