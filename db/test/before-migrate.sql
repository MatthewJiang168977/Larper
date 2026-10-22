-- A throwaway Postgres set up the way CloudNativePG sets up the stack's, so the database
-- tests run against the same roles and grants (CI's db job; README, "Tests"). Run as the
-- superuser on database larper, then the migrations as larper, then after-migrate.sql.
-- Test passwords only: this never runs against a real cluster.

-- CNPG's initdb: the owner, and the extensions created by the superuser.
-- (CREATEROLE comes from the owner's managed role in templates/postgres.yaml.)
CREATE ROLE larper LOGIN CREATEROLE PASSWORD 'owner-pw';
ALTER DATABASE larper OWNER TO larper;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;

-- Both orders 0010 must handle: CNPG creates these two before the migration runs (a
-- fresh install, where CNPG reconciles first); the migration creates the other two.
CREATE ROLE larper_api LOGIN PASSWORD 'api-pw';
CREATE ROLE larper_relay LOGIN PASSWORD 'relay-pw';

-- The backup check's role (templates/backup-check.yaml): only CNPG's managed roles
-- create it, since it needs no grant, so no migration touches it.
CREATE ROLE larper_backup_check LOGIN PASSWORD 'check-pw' CONNECTION LIMIT 1;
