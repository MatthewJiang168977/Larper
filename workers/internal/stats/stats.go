// Package stats recomputes the aggregates the niche score reads: per-cell tag
// counts (rarity), per-cell totals, and per-chain location counts (indie).
package stats

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Recompute rebuilds stats for every geohash6 cell inside the given geohash5
// areas, in one transaction so readers never see a half-updated area.
// Chain counts are global, so they're refreshed for every chain present in the areas,
// in chain_stats and on each place (places.chain_locations).
func Recompute(ctx context.Context, db interface {
	Begin(context.Context) (pgx.Tx, error)
}, geohash5 []string) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	stmts := []string{
		`DELETE FROM area_stats WHERE left(geohash6, 5) = ANY($1)`,
		`INSERT INTO area_stats (geohash6, tag, count)
		 SELECT geohash6, tag, count(*) FROM places, unnest(tags) AS tag
		 WHERE left(geohash6, 5) = ANY($1) GROUP BY 1, 2`,
		`DELETE FROM area_totals WHERE left(geohash6, 5) = ANY($1)`,
		`INSERT INTO area_totals (geohash6, places)
		 SELECT geohash6, count(*) FROM places WHERE left(geohash6, 5) = ANY($1) GROUP BY 1`,
		`INSERT INTO chain_stats (chain_key, locations)
		 SELECT chain_key, count(*) FROM places
		 WHERE chain_key IN (SELECT chain_key FROM places WHERE left(geohash6, 5) = ANY($1))
		 GROUP BY 1
		 ON CONFLICT (chain_key) DO UPDATE SET locations = EXCLUDED.locations`,
		// The same counts on the places themselves, which is what the API reads; every
		// location of those chains, wherever it is. Only rows whose count changed.
		`UPDATE places p SET chain_locations = c.n
		 FROM (SELECT chain_key, count(*)::int AS n FROM places
		       WHERE chain_key IN (SELECT chain_key FROM places WHERE left(geohash6, 5) = ANY($1))
		       GROUP BY 1) c
		 WHERE p.chain_key = c.chain_key AND p.chain_locations <> c.n`,
	}
	for _, s := range stmts {
		if _, err := tx.Exec(ctx, s, geohash5); err != nil {
			return fmt.Errorf("stats: %w", err)
		}
	}
	// A re-ingest can move a place to a new chain_key; drop counts nobody references.
	if _, err := tx.Exec(ctx, `DELETE FROM chain_stats c
		WHERE NOT EXISTS (SELECT 1 FROM places p WHERE p.chain_key = c.chain_key)`); err != nil {
		return fmt.Errorf("stats: %w", err)
	}
	return tx.Commit(ctx)
}
