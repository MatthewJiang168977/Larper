-- After the migrations: what CNPG does to the roles 0010 created (adopts them, turns on
-- LOGIN, sets the password from the Secret). See before-migrate.sql.
ALTER ROLE larper_taste LOGIN PASSWORD 'taste-pw';
ALTER ROLE larper_ingest LOGIN PASSWORD 'ingest-pw';
