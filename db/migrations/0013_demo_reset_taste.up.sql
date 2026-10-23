-- The nightly demo reset also puts the demo account's taste back to its baseline
-- (apps/api/src/ops/demo-reset.ts, DEMO_TASTE): it reads the tag slots to build the
-- vector and upserts the profile. An upsert needs INSERT and UPDATE, and SELECT for
-- the conflict check, as the taste-worker has.
GRANT SELECT                 ON tags           TO larper_demo_reset;
GRANT SELECT, INSERT, UPDATE ON taste_profiles TO larper_demo_reset;
