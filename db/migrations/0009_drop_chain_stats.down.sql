-- Recreates chain_stats as 0001 defined it, filled from the places (the same counts
-- as places.chain_locations). Rolling back the code too needs a worker that writes it.
CREATE TABLE chain_stats (
  chain_key text PRIMARY KEY,
  locations int  NOT NULL
);

INSERT INTO chain_stats (chain_key, locations)
SELECT chain_key, count(*) FROM places GROUP BY 1;
