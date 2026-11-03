# CNPG's "standard" image bundles pgvector; add PostGIS from the PGDG apt repo.
# (The separate cloudnative-pg/postgis image is stuck on Debian 11 and lacks pgvector.)
# Pinned by digest so the image (and its tag, scripts/pg-tag.sh) changes only on purpose;
# Dependabot opens a PR when 17-standard-bookworm moves. Majors are ignored there: a
# Postgres major upgrade needs its own plan.
FROM ghcr.io/cloudnative-pg/postgresql:17-standard-bookworm@sha256:e644949d3d14f66c4b4430db1cb7db939b78f727ae3d5590fb59c019dede0d75
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17-postgis-3 \
 && rm -rf /var/lib/apt/lists/*
USER 26
