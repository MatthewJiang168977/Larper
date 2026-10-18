-- One Postgres role per service, each granted only what its queries need
-- (docs/decisions/0003-service-db-roles.md has the matrix). This role, the database
-- owner (larper), keeps the schema: it alone runs DDL, and only the migrate Job uses it.
--
-- Roles are created here if missing, NOLOGIN. CloudNativePG's managed roles
-- (templates/postgres.yaml) turn on LOGIN, set each password from its Secret and the
-- connection limit. Either may come first: CNPG adopts a role this created, and this
-- skips one CNPG created. Creating a role needs CREATEROLE, which CNPG gives larper;
-- the migrate Job waits for it (templates/migrate.yaml).
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['larper_api', 'larper_relay', 'larper_taste', 'larper_ingest'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN', r);
      EXCEPTION WHEN duplicate_object THEN
        NULL; -- CNPG created it between the check and here
      END;
    END IF;
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO larper_api, larper_relay, larper_taste, larper_ingest;

-- Temporary tables: only the ingest's COPY stage needs one. PUBLIC has TEMP by default.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO larper_ingest', current_database());
END $$;

-- API: reads everything a deck needs; writes users, quests, onboarding profiles, jobs
-- (area ingest requests) and outbox rows. Never deletes.
GRANT SELECT, INSERT         ON users          TO larper_api;
GRANT SELECT, INSERT, UPDATE ON taste_profiles TO larper_api;
GRANT SELECT, INSERT, UPDATE ON quests         TO larper_api;
GRANT INSERT                 ON outbox         TO larper_api;
GRANT SELECT, INSERT         ON jobs           TO larper_api;
GRANT SELECT ON places, tags, area_stats, area_totals, areas_ingested TO larper_api;

-- outbox-relay: claims unsent rows (FOR UPDATE needs UPDATE), marks them sent, prunes
-- sent ones past the retention.
GRANT SELECT, UPDATE, DELETE ON outbox TO larper_relay;

-- taste-worker: dedupes events, updates the profile from the place's tag vector.
GRANT INSERT                 ON processed_events TO larper_taste;
GRANT SELECT, INSERT, UPDATE ON taste_profiles   TO larper_taste;
GRANT SELECT                 ON places           TO larper_taste;

-- ingest-worker (and the load-places CLI): upserts places, tags and ingested areas,
-- refreshes the area stats (delete and rewrite), and works the jobs queue.
GRANT SELECT, INSERT, UPDATE ON places, tags, areas_ingested TO larper_ingest;
GRANT SELECT, INSERT, DELETE ON area_stats, area_totals      TO larper_ingest;
GRANT SELECT, UPDATE         ON jobs                         TO larper_ingest;
