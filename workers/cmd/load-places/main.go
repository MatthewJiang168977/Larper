// load-places bulk-loads an Overture extract (data/extract_overture.py output)
// into Postgres. The pipeline itself lives in internal/places, shared with the
// ingest-worker that loads single areas on demand.
//
//	kubectl -n larper port-forward svc/pg-rw 55432:5432
//	DATABASE_URL=postgres://larper:...@127.0.0.1:55432/larper go run ./cmd/load-places -in ../data/nyc.parquet
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/MatthewJiang168977/larper/workers/internal/places"
	"github.com/MatthewJiang168977/larper/workers/internal/taxonomy"
)

func main() {
	in := flag.String("in", "", "parquet file from extract_overture.py")
	release := flag.String("release", "2026-09-23.1", "Overture release the file came from")
	minConf := flag.Float64("min-confidence", 0.5, "drop places Overture is less sure exist")
	flag.Parse()
	if *in == "" || os.Getenv("DATABASE_URL") == "" {
		fmt.Fprintln(os.Stderr, "usage: DATABASE_URL=... load-places -in file.parquet")
		os.Exit(2)
	}

	ctx := context.Background()
	start := time.Now()
	tax, err := taxonomy.Default()
	if err != nil {
		fail(err)
	}
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		fail(err)
	}
	defer pool.Close()

	res, err := places.Load(ctx, pool, tax, places.Options{Path: *in, Release: *release, MinConf: *minConf})
	if err != nil {
		fail(err)
	}
	slog.Info("done", "read", res.Read, "kept", res.Kept, "areas", len(res.Areas),
		"taxonomy", tax.Version, "elapsed", time.Since(start).Round(time.Millisecond))
}

func fail(err error) {
	slog.Error("load failed", "err", err)
	os.Exit(1)
}
