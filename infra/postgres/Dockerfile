# CNPG's "standard" image bundles pgvector; add PostGIS from the PGDG apt repo.
# (The separate cloudnative-pg/postgis image is stuck on Debian 11 and lacks pgvector.)
FROM ghcr.io/cloudnative-pg/postgresql:17-standard-bookworm
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17-postgis-3 \
 && rm -rf /var/lib/apt/lists/*
USER 26
