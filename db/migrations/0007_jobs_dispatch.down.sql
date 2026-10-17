DROP INDEX IF EXISTS jobs_undispatched;
ALTER TABLE jobs DROP COLUMN IF EXISTS dispatched_at;
