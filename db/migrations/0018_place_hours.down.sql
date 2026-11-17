-- Dropping the table takes its grants and indexes with it. Only the new pods touch it, so roll
-- the API back first.
DROP TABLE IF EXISTS place_hours_facts;
