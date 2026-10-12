# Go workers. Build context: workers/. Two targets:
#   static (default)  every Go command on distroless: relay, taste-worker, load-places
#   ingest            ingest-worker + the DuckDB CLI, which needs glibc
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ ./cmd/...

FROM debian:bookworm-slim AS ingest
ARG DUCKDB_VERSION=1.5.6
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && curl -fsSL -o /tmp/duckdb.zip \
      "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb_cli-linux-amd64.zip" \
 && unzip /tmp/duckdb.zip -d /usr/local/bin \
 && rm /tmp/duckdb.zip \
 && apt-get purge -y curl unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 10001 app
USER app
# Bake the extensions into the image so jobs never download them at runtime.
RUN duckdb -c "INSTALL httpfs; INSTALL spatial;"
COPY --from=build /out/ingest-worker /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/ingest-worker"]

# Static binaries need no OS: distroless has no shell or package manager to exploit.
FROM gcr.io/distroless/static-debian12:nonroot AS static
COPY --from=build /out/ /usr/local/bin/
USER nonroot
