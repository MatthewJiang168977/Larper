-- Why a quest was set aside. "Not today" on an accepted quest skips it with no taste
-- change and sets 'unstated'; the user can then give one reason, once. NULL is a plain
-- Skip (an offered quest turned down, which nudges taste away as before).
-- Only "Not my thing" moves taste (the skip penalty); the rest are kept for analysis.
CREATE TYPE skip_reason AS ENUM ('unstated', 'not_my_thing', 'too_far', 'not_today', 'closed');

ALTER TABLE quests ADD COLUMN skip_reason skip_reason;
