-- Why a place's point can't be trusted, or NULL. The loader sets it from the Overture
-- address (workers/internal/places/location.go): a postcode outside the region, a
-- foreign address, or a reported place. A flagged place keeps its row (quests point at
-- it) but never reaches a deck (the API's candidates query) or the area stats.
--
-- Rows loaded before this column stay NULL until the next load of their area. On
-- 2026-10-24 a Union Square deck offered "VerKeerderkill Falls, Sams Point Preserve"
-- (the Catskills) as a lead: Overture pins it in Manhattan.
ALTER TABLE places ADD COLUMN location_suspect text;
