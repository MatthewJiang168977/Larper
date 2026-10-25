// load-places bulk-loads an Overture extract (data/extract_overture.py output)
// into Postgres. The pipeline itself lives in internal/places, shared with the
// ingest-worker that loads single areas on demand.
//
//	kubectl -n larper port-forward svc/pg-rw 55432:5432
//	DATABASE_URL=postgres://larper_ingest:...@127.0.0.1:55432/larper go run ./cmd/load-places -in ../data/nyc.parquet
//
// With -bbox instead of -in it extracts the box itself first (DuckDB on PATH, as in the
// ingest image), the same query the ingest-worker runs per area, and logs how long the
// extract and the load each took: scripts/oci-reload-places.sh runs it that way on the
// VM, which is how a metro's load time is measured.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/MatthewJiang168977/larper/workers/internal/places"
	"github.com/MatthewJiang168977/larper/workers/internal/taxonomy"
)

func main() {
	in := flag.String("in", "", "parquet file from extract_overture.py")
	bbox := flag.String("bbox", "", `instead of -in: extract this box first, "xmin,ymin,xmax,ymax" (lng,lat,lng,lat), e.g. -74.26,40.49,-73.70,40.92`)
	release := flag.String("release", "2026-09-23.1", "Overture release the file came from")
	minConf := flag.Float64("min-confidence", 0.5, "drop places Overture is less sure exist")
	prefixes := flag.String("postcode-prefixes", os.Getenv("PLACE_POSTCODE_PREFIXES"),
		`US ZIP prefixes inside the region ("nyc", or a comma list): places whose postcode contradicts it are flagged; empty checks only the reported list`)
	flag.Parse()
	if (*in == "") == (*bbox == "") || os.Getenv("DATABASE_URL") == "" {
		fmt.Fprintln(os.Stderr, "usage: DATABASE_URL=... load-places -in file.parquet | -bbox xmin,ymin,xmax,ymax")
		os.Exit(2)
	}

	ctx := context.Background()
	start := time.Now()
	if *bbox != "" {
		box, err := parseBox(*bbox)
		if err != nil {
			fail(err)
		}
		path := filepath.Join(os.TempDir(), fmt.Sprintf("load-places-%d.parquet", time.Now().UnixNano()))
		defer os.Remove(path)
		mem := envOr("DUCKDB_MEMORY_LIMIT", "2GB")
		threads, _ := strconv.Atoi(envOr("DUCKDB_THREADS", "2"))
		if err := places.Extract(ctx, box, *release, path, mem, threads); err != nil {
			fail(err)
		}
		size := int64(0)
		if fi, err := os.Stat(path); err == nil {
			size = fi.Size()
		}
		slog.Info("extracted", "bbox", *bbox, "release", *release, "bytes", size,
			"duckdb_memory", mem, "duckdb_threads", threads, "elapsed", time.Since(start).Round(time.Millisecond))
		*in = path
	}
	loadStart := time.Now()
	tax, err := taxonomy.Default()
	if err != nil {
		fail(err)
	}
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		fail(err)
	}
	defer pool.Close()

	res, err := places.Load(ctx, pool, tax, places.Options{Path: *in, Release: *release, MinConf: *minConf,
		Location: places.LocationCheck{PostcodePrefixes: places.ParsePrefixes(*prefixes)}})
	if err != nil {
		fail(err)
	}
	slog.Info("done", "read", res.Read, "kept", res.Kept, "areas", len(res.Areas),
		"taxonomy", tax.Version, "load", time.Since(loadStart).Round(time.Millisecond),
		"elapsed", time.Since(start).Round(time.Millisecond))
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func parseBox(s string) (places.Box, error) {
	parts := strings.Split(s, ",")
	if len(parts) != 4 {
		return places.Box{}, fmt.Errorf("bbox: want xmin,ymin,xmax,ymax, got %q", s)
	}
	var v [4]float64
	for i, p := range parts {
		f, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil {
			return places.Box{}, fmt.Errorf("bbox: %q: %w", p, err)
		}
		v[i] = f
	}
	if v[0] >= v[2] || v[1] >= v[3] || v[0] < -180 || v[2] > 180 || v[1] < -90 || v[3] > 90 {
		return places.Box{}, fmt.Errorf("bbox: %q isn't a box (lng,lat,lng,lat; min < max)", s)
	}
	return places.Box{MinLng: v[0], MinLat: v[1], MaxLng: v[2], MaxLat: v[3]}, nil
}

func fail(err error) {
	slog.Error("load failed", "err", err)
	os.Exit(1)
}
