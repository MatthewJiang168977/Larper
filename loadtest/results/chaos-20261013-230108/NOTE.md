# Reading this run

- **Valid:** request counts, failures and error windows for every kill, the Postgres
  "ready again" time (12 s, from its own UID check), and the healing checks.
- **Not valid:** "Ready again after: timeouts" for the API, worker and Redis kills. The
  readiness check in `loadtest/chaos.sh` had a literal newline inside a kubectl jsonpath
  (`{"\n"}`), so kubectl rejected it on every poll. Fixed after this run; recovery times
  for those kills are in the previous run (chaos-20261013-121403) and the next one.
- **Postgres kill vs the previous run:** 165 failed requests (all 500) instead of 465
  (307 × 503, 148 × 502, 10 × 500), and all API pods kept running (0 restarts), where
  before every API pod crashed on the unhandled pool `error` event. The error window is
  longer (17 s vs 11 s) because requests now wait up to the 5 s connect timeout instead of
  failing instantly on a dead pod.
- API config under test: 300m request, no CPU limit, HPA 60% (ADR 0001). The API tests
  (tsc + jest) ran on the same laptop during part of this run.
