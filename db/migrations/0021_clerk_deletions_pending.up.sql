-- Clerk users whose deletion is still owed (docs/decisions/0005-data-deletion.md, D8).
--
-- DELETE /me purges Larper's data first and then deletes the Clerk user. If Clerk fails,
-- the data is already gone but the Clerk user (email, name) is not, and until now nothing
-- remembered that: the user could close the tab and stay in Clerk for good, or come back
-- and get a fresh, empty account. A row here means "this Clerk user must be deleted":
--   - the API retries the Clerk deletion in the background until it succeeds;
--   - the API refuses to create an account for a Clerk id listed here (401 account_gone);
--   - a Clerk user.deleted webhook for the id also settles it.
-- The row holds the Clerk id only (needed to finish the deletion) and goes as soon as
-- Clerk confirms. The API inserts and updates it; removing a row goes through
-- clerk_deletion_done(), so the API role still has no DELETE grant (decision 0003).
CREATE TABLE clerk_deletions_pending (
  clerk_id        text PRIMARY KEY CHECK (clerk_id ~ '^user_[A-Za-z0-9]+$'),
  first_failed_at timestamptz NOT NULL DEFAULT now(),
  attempts        integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clerk_deletions_pending_due ON clerk_deletions_pending (next_attempt_at);

GRANT SELECT, INSERT, UPDATE ON clerk_deletions_pending TO larper_api;

CREATE FUNCTION clerk_deletion_done(p_clerk_id text) RETURNS boolean
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH d AS (DELETE FROM clerk_deletions_pending WHERE clerk_id = p_clerk_id RETURNING 1)
  SELECT count(*) > 0 FROM d
$$;

REVOKE ALL ON FUNCTION clerk_deletion_done(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clerk_deletion_done(text) TO larper_api;
