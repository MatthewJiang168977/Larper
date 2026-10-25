// Package places loads Overture extracts into Postgres: tag each place with the
// niche taxonomy, upsert the quest-worthy ones, mark their geohash5 areas as
// ingested, and recompute area/chain stats. Shared by the load-places bulk loader
// and the ingest-worker, so both paths produce identical rows.
package places

import (
	"context"
	"fmt"
	"io"
	"os"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/parquet-go/parquet-go"

	"github.com/MatthewJiang168977/larper/workers/internal/stats"
	"github.com/MatthewJiang168977/larper/workers/internal/taxonomy"
)

// Columns written by overture_extract.sql.
type overtureRow struct {
	OvertureID string   `parquet:"overture_id"`
	Name       *string  `parquet:"name"`
	Lng        *float64 `parquet:"lng"`
	Lat        *float64 `parquet:"lat"`
	Confidence *float64 `parquet:"confidence"`
	Hierarchy  []string `parquet:"hierarchy,list"`
	Alternates []string `parquet:"alternates,list"`
	Brand      *string  `parquet:"brand"`
	Website    *string  `parquet:"website"`
	Instagram  *string  `parquet:"instagram"`
	Phone      *string  `parquet:"phone"`
	Postcode   *string  `parquet:"postcode"`
	Street     *string  `parquet:"street"`
}

type Options struct {
	Path    string // parquet file from Extract or data/extract_overture.py
	Release string // Overture release it came from
	MinConf float64
	// MarkOnly, when set, is exactly the set of geohash5 areas to mark ingested: the
	// ingest-worker's one requested cell, even if it held no quest-worthy places (a
	// river). Unset (bulk loads), every area a place landed in is marked. Either way,
	// stats are recomputed for every area a place landed in.
	MarkOnly []string
	// Location flags places whose address contradicts their point (location.go).
	Location LocationCheck
}

type Result struct {
	Read, Kept int
	Areas      []string // geohash5 areas whose stats were recomputed (places landed there)
}

// Load runs the whole pipeline for one extract file.
func Load(ctx context.Context, pool *pgxpool.Pool, tax *taxonomy.Taxonomy, o Options) (Result, error) {
	rows, read, err := tagFile(o.Path, tax, o.MinConf, o.Location)
	if err != nil {
		return Result{}, err
	}
	if err := syncTags(ctx, pool, tax); err != nil {
		return Result{}, err
	}
	areas, err := upsert(ctx, pool, rows, o.Release, o.MarkOnly)
	if err != nil {
		return Result{}, err
	}
	if err := stats.Recompute(ctx, pool, areas); err != nil {
		return Result{}, err
	}
	return Result{Read: read, Kept: len(rows), Areas: areas}, nil
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func ptr(s string) *string { return &s }

// orNull keeps NULLs NULL in the COPY instead of turning them into "".
func orNull(p *string) any {
	if p == nil || *p == "" {
		return nil
	}
	return *p
}

// tagFile streams the parquet file and returns copy-ready rows for places that
// fire at least one tag, each with why its point is suspect (NULL if it isn't).
func tagFile(path string, tax *taxonomy.Taxonomy, minConf float64, loc LocationCheck) ([][]any, int, error) {
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
			res := tax.Tag(taxonomy.Place{Name: *p.Name, Hierarchy: p.Hierarchy, Alternates: p.Alternates})
			if res.Vec == nil {
				continue
			}
			out = append(out, []any{
				p.OvertureID, *p.Name, *p.Lng, *p.Lat, p.Hierarchy, orNull(p.Brand),
				taxonomy.ChainKey(*p.Name, str(p.Brand)),
				res.Tags, taxonomy.VectorLiteral(res.Vec), float32(*p.Confidence),
				orNull(p.Website), orNull(p.Instagram), orNull(p.Phone),
				orNull(ptr(loc.Suspect(p.OvertureID, str(p.Postcode), str(p.Street)))),
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

// syncTags publishes the slot -> tag mapping so the API can build taste vectors
// with the same layout as place vectors.
func syncTags(ctx context.Context, pool *pgxpool.Pool, tax *taxonomy.Taxonomy) error {
	var slots []int32
	var names []string
	for _, s := range tax.Slots() {
		slots = append(slots, int32(s))
		names = append(names, tax.TagName(s))
	}
	_, err := pool.Exec(ctx, `
		INSERT INTO tags (slot, tag) SELECT * FROM unnest($1::int[], $2::text[])
		ON CONFLICT (slot) DO UPDATE SET tag = EXCLUDED.tag`, slots, names)
	if err != nil {
		return fmt.Errorf("tags: %w", err)
	}
	return nil
}

// upsert COPYs rows into a temp table and merges them into places in one
// transaction. Returns the geohash5 areas touched.
func upsert(ctx context.Context, pool *pgxpool.Pool, rows [][]any, release string, markOnly []string) ([]string, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `CREATE TEMP TABLE stage (
		overture_id text, name text, lng float8, lat float8, categories text[], brand text,
		chain_key text, tags text[], tag_vec text, confidence real,
		website text, instagram text, phone text, location_suspect text) ON COMMIT DROP`); err != nil {
		return nil, err
	}
	cols := []string{"overture_id", "name", "lng", "lat", "categories", "brand", "chain_key", "tags", "tag_vec", "confidence",
		"website", "instagram", "phone", "location_suspect"}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"stage"}, cols, pgx.CopyFromRows(rows)); err != nil {
		return nil, fmt.Errorf("copy: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO places (overture_id, name, geom, categories, brand, chain_key, tags, tag_vec, confidence,
		                    website, instagram, phone, location_suspect)
		SELECT overture_id, name, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
		       categories, brand, chain_key, tags, tag_vec::vector, confidence, website, instagram, phone,
		       location_suspect
		FROM stage
		ON CONFLICT (overture_id) DO UPDATE SET
		  name = EXCLUDED.name, geom = EXCLUDED.geom, categories = EXCLUDED.categories,
		  brand = EXCLUDED.brand, chain_key = EXCLUDED.chain_key, tags = EXCLUDED.tags,
		  tag_vec = EXCLUDED.tag_vec, confidence = EXCLUDED.confidence, website = EXCLUDED.website,
		  instagram = EXCLUDED.instagram, phone = EXCLUDED.phone,
		  location_suspect = EXCLUDED.location_suspect, updated_at = now()`); err != nil {
		return nil, fmt.Errorf("merge: %w", err)
	}

	var touched []string
	if err := tx.QueryRow(ctx, `
		SELECT coalesce(array_agg(DISTINCT ST_GeoHash(ST_SetSRID(ST_MakePoint(lng, lat), 4326), 5)), '{}')
		FROM stage`).Scan(&touched); err != nil {
		return nil, fmt.Errorf("areas: %w", err)
	}
	mark := touched
	if markOnly != nil {
		mark = markOnly
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO areas_ingested (geohash5, source_release) SELECT unnest($2::text[]), $1
		ON CONFLICT (geohash5) DO UPDATE SET source_release = EXCLUDED.source_release, ingested_at = now()`,
		release, mark); err != nil {
		return nil, fmt.Errorf("mark areas: %w", err)
	}
	return touched, tx.Commit(ctx)
}
