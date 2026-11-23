-- Roll the API back first: the new pods read and write this table.
-- Any rows still here are Clerk users whose deletion is owed: delete them in Clerk by hand
-- before rolling back (SELECT clerk_id FROM clerk_deletions_pending).
DROP FUNCTION IF EXISTS clerk_deletion_done(text);
DROP TABLE IF EXISTS clerk_deletions_pending;
