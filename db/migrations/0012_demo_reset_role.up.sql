-- The public demo's nightly reset (apps/api/src/ops/demo-reset.ts, the chart's
-- demo-reset CronJob): it deletes the shared demo account's quests, found by its Clerk
-- id. Its own role, so the API keeps never deleting. Created here if missing, NOLOGIN,
-- as in 0010; CloudNativePG's managed roles turn on LOGIN with a connection limit of 1.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'larper_demo_reset') THEN
    BEGIN
      CREATE ROLE larper_demo_reset NOLOGIN;
    EXCEPTION WHEN duplicate_object THEN
      NULL; -- CNPG created it between the check and here
    END;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO larper_demo_reset;
-- DELETE ... WHERE user_id = (SELECT id FROM users WHERE clerk_id = $1): reading the
-- WHERE clause's columns needs SELECT on both tables.
GRANT SELECT         ON users  TO larper_demo_reset;
GRANT SELECT, DELETE ON quests TO larper_demo_reset;
