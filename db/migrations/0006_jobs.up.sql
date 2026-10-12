-- A small work queue with Azure Service Bus semantics, so the cloud deploy can swap
-- in Service Bus behind the same interface (apps/api/src/jobs, workers/internal/queue):
--   peek-lock     a worker leases a job until locked_until; if it dies, the lease
--                 lapses and another worker reclaims it (redelivery)
--   max delivery  attempts are counted; past max_attempts the job is 'dead'
--                 (the dead-letter queue), with the last error kept for inspection
--   dedupe        at most one live job per (queue, dedupe_key)
CREATE TYPE job_status AS ENUM ('queued', 'running', 'done', 'dead');

CREATE TABLE jobs (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue        text        NOT NULL,
  dedupe_key   text        NOT NULL,
  payload      jsonb       NOT NULL,
  status       job_status  NOT NULL DEFAULT 'queued',
  attempts     int         NOT NULL DEFAULT 0,
  max_attempts int         NOT NULL DEFAULT 5,
  run_after    timestamptz NOT NULL DEFAULT now(),  -- backoff: not claimable before this
  locked_until timestamptz,                         -- lease expiry while running
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX jobs_one_live ON jobs (queue, dedupe_key) WHERE status IN ('queued', 'running');
-- Claim scans: ready queued jobs, and running jobs whose lease has lapsed.
CREATE INDEX jobs_claimable ON jobs (queue, run_after) WHERE status IN ('queued', 'running');
