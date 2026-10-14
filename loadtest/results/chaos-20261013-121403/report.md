# Failure test, 2026-10-13 16:14 UTC

Steady load for 425 s: 21957 requests, 465 failed (2.12%).
Failed by status: 500 ×10, 502 ×148, 503 ×307.

| At | Killed | Requests (next 60 s) | Failed | User-visible error window | Ready again after |
|---|---|---|---|---|---|
| 61 s | api-6c67c5f988-78znz (force) | 3197 | 0 | — | 8s |
| 121 s | api-6c67c5f988-84nwg (graceful) | 3045 | 0 | — | 11s |
| 181 s | taste-worker-7568cc8d7d-j5cml (force) | 168 | 0 | — | 1s |
| 184 s | ingest-worker-85d88b5fcf-5bqq2 (force) | 160 | 0 | — | 0s |
| 187 s | outbox-relay-788bb59c7c-gfc6c (force) | 2744 | 0 | — | 0s |
| 240 s | redis-5bdc64d65d-n6dq2 (force) | 2999 | 0 | — | 4s |
| 300 s | pg-1 (force) | 3093 | 465 | 11 s | 15s |

Failures before the first kill (baseline): 0.

Healing after the load stopped:
- kafka-lag-zero after 1s
- outbox-drained after 0s
- all-deployments api=6/6 ingest-worker=2/2 outbox-relay=1/1 redis=1/1 taste-worker=2/2
