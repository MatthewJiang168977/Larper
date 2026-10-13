-- In the cloud, jobs are delivered by Amazon SQS and this table becomes the ledger:
-- it still owns dedupe (one live job per key) and status (the API's "failed areas"
-- check), while SQS owns delivery, leases and redelivery. dispatched_at makes the
-- table an outbox for SQS: the API inserts a row, the dispatcher sends it and stamps
-- it, so a crash between the two re-sends instead of losing the job.
ALTER TABLE jobs ADD COLUMN dispatched_at timestamptz;

CREATE INDEX jobs_undispatched ON jobs (id) WHERE status = 'queued' AND dispatched_at IS NULL;
