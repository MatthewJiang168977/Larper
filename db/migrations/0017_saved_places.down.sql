-- Dropping the table takes its grants (the API's and the demo reset's) with it. Only the
-- new pods write to it, so roll the API back first.
DROP TABLE IF EXISTS saved_places;
