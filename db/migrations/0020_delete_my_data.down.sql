-- Roll the API and taste worker back first: the new pods call these functions, and
-- the API writes NULL origins.
DROP FUNCTION IF EXISTS export_my_checkin_attempts(bigint);
DROP FUNCTION IF EXISTS delete_my_account(bigint);
DROP FUNCTION IF EXISTS delete_my_history(bigint);
DROP FUNCTION IF EXISTS lock_user_quest(bigint, bigint);
-- The positions that were dropped are gone for good. NOT NULL comes back with the place's
-- own point standing in for them (the offer was somewhere near it).
UPDATE quests q SET origin = p.geom FROM places p WHERE p.id = q.place_id AND q.origin IS NULL;
ALTER TABLE quests ALTER COLUMN origin SET NOT NULL;
