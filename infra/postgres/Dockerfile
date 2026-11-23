# CNPG's "standard" image bundles pgvector; add PostGIS from the PGDG apt repo.
# (The separate cloudnative-pg/postgis image is stuck on Debian 11 and lacks pgvector.)
# Pinned by digest so the image (and its tag, scripts/pg-tag.sh) changes only on purpose;
# Dependabot opens a PR when 17-standard-bookworm moves. Majors are ignored there: a
# Postgres major upgrade needs its own plan.
FROM ghcr.io/cloudnative-pg/postgresql:17-standard-bookworm@sha256:170687d70a061ffb2c087b48bccef0c3e5b57dc31096914499ced8ced60b304b
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17-postgis-3 \
 && rm -rf /var/lib/apt/lists/*
USER 26
