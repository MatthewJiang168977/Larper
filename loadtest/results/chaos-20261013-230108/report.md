# Failure test, 2026-10-14 03:01 UTC

Steady load for 432 s: 21962 requests, 165 failed (0.75%).
Failed by status: 500 ×165.

| At | Killed | Requests (next 60 s) | Failed | User-visible error window | Ready again after |
|---|---|---|---|---|---|
| 61 s | api-5b575b7cd7-2gxvs (force) | 3430 | 0 | — | timeouts |
| 121 s | api-5b575b7cd7-75kvr (graceful) | 3360 | 0 | — | timeouts |
| 181 s | taste-worker-7568cc8d7d-h4css (force) | 161 | 0 | — | timeouts |
| 184 s | ingest-worker-69947fff59-8w277 (force) | 57 | 0 | — | timeouts |
| 185 s | outbox-relay-788bb59c7c-pcrrc (force) | 3206 | 0 | — | timeouts |
| 242 s | redis-5bdc64d65d-8gdvq (force) | 3176 | 0 | — | timeouts |
| 303 s | pg-1 (force) | 2505 | 165 | 17 s | 12s |

Failures before the first kill (baseline): 0.

Healing after the load stopped:
- kafka-lag-zero after 1s
- outbox-drained after 1s
- all-deployments api=6/6 ingest-worker=2/2 outbox-relay=1/1 redis=1/1 taste-worker=2/2
