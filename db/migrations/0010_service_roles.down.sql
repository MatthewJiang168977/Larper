-- Takes back every grant 0010 made. The roles stay: CloudNativePG manages them (and
-- would recreate them), and pods still running the old release may be logged in.
-- Point the pods back at pg-app before rolling this back.
REVOKE ALL ON users, taste_profiles, quests, outbox, jobs, places, tags, area_stats,
  area_totals, areas_ingested, processed_events
  FROM larper_api, larper_relay, larper_taste, larper_ingest;

DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM larper_ingest', current_database());
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC', current_database());
END $$;

REVOKE USAGE ON SCHEMA public FROM larper_api, larper_relay, larper_taste, larper_ingest;
