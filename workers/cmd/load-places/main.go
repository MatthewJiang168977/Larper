// load-places bulk-loads an Overture extract (data/extract_overture.py output)
// into Postgres: tags each place, upserts the quest-worthy ones, marks their
// geohash5 areas as ingested, and recomputes area/chain stats for those areas.
//
//	kubectl -n larper port-forward svc/pg-rw 5432:5432
//	DATABASE_URL=postgres://larper:...@localhost:5432/larper go run ./cmd/load-places -in ../data/nyc.parquet
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/parquet-go/parquet-go"

	"github.com/MatthewJiang168977/larper/workers/internal/stats"
	"github.com/MatthewJiang168977/larper/workers/internal/taxonomy"
)

// Columns written by data/extract_overture.py.
type overtureRow struct {
	OvertureID string   `parquet:"overture_id"`
	Name       *string  `parquet:"name"`
	Lng        *float64 `parquet:"lng"`
	Lat        *float64 `parquet:"lat"`
	Confidence *float64 `parquet:"confidence"`
	Hierarchy  []string `parquet:"hierarchy,list"`
	Alternates []string `parquet:"alternates,list"`
	Brand      *string  `parquet:"brand"`
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func main() {
	in := flag.String("in", "", "parquet file from extract_overture.py")
	release := flag.String("release", "2026-09-23.1", "Overture release the file came from")
	minConf := flag.Float64("min-confidence", 0.5, "drop places Overture is less sure exist")
	flag.Parse()
	if *in == "" || os.Getenv("DATABASE_URL") == "" {
		fmt.Fprintln(os.Stderr, "usage: DATABASE_URL=... load-places -in file.parquet")
		os.Exit(2)
	}
	if err := run(context.Background(), *in, *release, *minConf); err != nil {
		slog.Error("load failed", "err", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, path, release string, minConf float64) error {
	start := time.Now()
	tx, err := taxonomy.Default()
	if err != nil {
		return err
	}

	rows, read, err := tagFile(path, tx, minConf)
	if err != nil {
		return err
	}
	slog.Info("tagged", "read", read, "kept", len(rows), "taxonomy", tx.Version)

	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()

	areas, err := upsert(ctx, pool, rows, release)
	if err != nil {
		return err
	}
	slog.Info("upserted", "places", len(rows), "areas", len(areas))

	if err := stats.Recompute(ctx, pool, areas); err != nil {
		return err
	}
	slog.Info("done", "elapsed", time.Since(start).Round(time.Millisecond))
	return nil
}

// tagFile streams the parquet file and returns copy-ready rows for places that
// fire at least one tag.
func tagFile(path string, tx *taxonomy.Taxonomy, minConf float64) ([][]any, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()

	r := parquet.NewGenericReader[overtureRow](f)
	defer r.Close()

	var out [][]any
	read := 0
	buf := make([]overtureRow, 4096)
	for {
		n, err := r.Read(buf)
		for _, p := range buf[:n] {
			read++
			if p.Name == nil || p.Lng == nil || p.Lat == nil || p.Confidence == nil || *p.Confidence < minConf {
				continue
			}
			res := tx.Tag(taxonomy.Place{Name: *p.Name, Hierarchy: p.Hierarchy, Alternates: p.Alternates})
			if res.Vec == nil {
				continue
			}
			var brand any
			if p.Brand != nil {
				brand = *p.Brand
			}
			out = append(out, []any{
				p.OvertureID, *p.Name, *p.Lng, *p.Lat, p.Hierarchy, brand,
				taxonomy.ChainKey(*p.Name, str(p.Brand)),
				res.Tags, taxonomy.VectorLiteral(res.Vec), float32(*p.Confidence),
			})
		}
		if err == io.EOF {
			return out, read, nil
		}
		if err != nil {
			return nil, read, err
		}
	}
}

// upsert COPYs rows into a temp table and merges them into places in one
// transaction. Returns the geohash5 areas touched.
func upsert(ctx context.Context, pool *pgxpool.Pool, rows [][]any, release string) ([]string, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `CREATE TEMP TABLE stage (
		overture_id text, name text, lng float8, lat float8, categories text[], brand text,
		chain_key text, tags text[], tag_vec text, confidence real) ON COMMIT DROP`); err != nil {
		return nil, err
	}
	cols := []string{"overture_id", "name", "lng", "lat", "categories", "brand", "chain_key", "tags", "tag_vec", "confidence"}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"stage"}, cols, pgx.CopyFromRows(rows)); err != nil {
		return nil, fmt.Errorf("copy: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO places (overture_id, name, geom, categories, brand, chain_key, tags, tag_vec, confidence)
		SELECT overture_id, name, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
		       categories, brand, chain_key, tags, tag_vec::vector, confidence
		FROM stage
		ON CONFLICT (overture_id) DO UPDATE SET
		  name = EXCLUDED.name, geom = EXCLUDED.geom, categories = EXCLUDED.categories,
		  brand = EXCLUDED.brand, chain_key = EXCLUDED.chain_key, tags = EXCLUDED.tags,
		  tag_vec = EXCLUDED.tag_vec, confidence = EXCLUDED.confidence, updated_at = now()`); err != nil {
		return nil, fmt.Errorf("merge: %w", err)
	}

	var areas []string
	if err := tx.QueryRow(ctx, `
		WITH a AS (
		  INSERT INTO areas_ingested (geohash5, source_release)
		  SELECT DISTINCT ST_GeoHash(ST_SetSRID(ST_MakePoint(lng, lat), 4326), 5), $1 FROM stage
		  ON CONFLICT (geohash5) DO UPDATE SET source_release = EXCLUDED.source_release, ingested_at = now()
		  RETURNING geohash5)
		SELECT coalesce(array_agg(geohash5), '{}') FROM a`, release).Scan(&areas); err != nil {
		return nil, fmt.Errorf("areas: %w", err)
	}
	return areas, tx.Commit(ctx)
}
