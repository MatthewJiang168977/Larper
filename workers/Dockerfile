# Go workers. Build context: workers/. Two targets:
#   static (default)  every Go command on distroless: relay, taste-worker, load-places
#   ingest            ingest-worker + the DuckDB CLI, which needs glibc
# Multi-arch (amd64 + arm64): Go cross-compiles on the build machine's own platform,
# so only the small final stages run per target architecture.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/ ./cmd/...

FROM debian:bookworm-slim AS ingest
ARG DUCKDB_VERSION=1.5.6
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && curl -fsSL -o /tmp/duckdb.zip \
      "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb_cli-linux-${TARGETARCH}.zip" \
 && unzip /tmp/duckdb.zip -d /usr/local/bin \
 && rm /tmp/duckdb.zip \
 && apt-get purge -y curl unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 app
USER app
# Bake the extensions into the image so jobs never download them at runtime.
RUN duckdb -c "INSTALL httpfs; INSTALL spatial;"
# load-places too: with -bbox it extracts with this image's DuckDB, so a whole metro can
# be (re)loaded on the cluster (scripts/oci-reload-places.sh).
COPY --from=build /out/ingest-worker /out/load-places /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/ingest-worker"]

# Static binaries need no OS: distroless has no shell or package manager to exploit.
FROM gcr.io/distroless/static-debian12:nonroot AS static
COPY --from=build /out/ /usr/local/bin/
USER nonroot
