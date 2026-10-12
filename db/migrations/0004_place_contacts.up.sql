-- Contact links for the quest card, from Overture (CDLA-permissive, storable).
ALTER TABLE places
  ADD COLUMN website   text,
  ADD COLUMN instagram text,
  ADD COLUMN phone     text;
