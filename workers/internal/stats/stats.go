// Package stats recomputes the aggregates the niche score reads: per-cell tag
// counts (rarity), per-cell totals, and per-chain location counts (indie).
package stats

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// chainLockClass namespaces the per-chain advisory locks (two-int form, so they can't
// collide with single-bigint locks such as golang-migrate's).
const chainLockClass = 0x4c43 // "LC"

// Recompute rebuilds stats for every geohash6 cell inside the given geohash5
// areas, in one transaction so readers never see a half-updated area.
// Chain counts are global, so they're refreshed for every chain present in the areas,
// on each of its places (places.chain_locations).
func Recompute(ctx context.Context, db interface {
	Begin(context.Context) (pgx.Tx, error)
}, geohash5 []string) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Two refreshes of different areas can share a chain. Under READ COMMITTED each
	// computes the chain's count from its own snapshot, and an UPDATE that waits on a
	// row lock re-checks its WHERE against the newer row but keeps its old count, so
	// the later commit could overwrite a newer count with a staler one. Lock the chains
	// first, in a fixed order (no deadlocks), before any row lock; a refresh that
	// waits here counts with a snapshot taken after the other one committed. Only the
	// chains locked here are recounted: a chain that turns up in these areas later
	// belongs to a load whose own refresh follows it.
	var chains []string
	if err := tx.QueryRow(ctx, `SELECT coalesce(array_agg(DISTINCT chain_key), '{}')
		FROM places WHERE left(geohash6, 5) = ANY($1)`, geohash5).Scan(&chains); err != nil {
		return fmt.Errorf("stats: %w", err)
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($2, k)
		FROM (SELECT DISTINCT hashtext(c) AS k FROM unnest($1::text[]) AS c ORDER BY 1) s`,
		chains, chainLockClass); err != nil {
		return fmt.Errorf("stats: lock chains: %w", err)
	}

	areaStmts := []string{
		`DELETE FROM area_stats WHERE left(geohash6, 5) = ANY($1)`,
		`INSERT INTO area_stats (geohash6, tag, count)
		 SELECT geohash6, tag, count(*) FROM places, unnest(tags) AS tag
		 WHERE left(geohash6, 5) = ANY($1) GROUP BY 1, 2`,
		`DELETE FROM area_totals WHERE left(geohash6, 5) = ANY($1)`,
		`INSERT INTO area_totals (geohash6, places)
		 SELECT geohash6, count(*) FROM places WHERE left(geohash6, 5) = ANY($1) GROUP BY 1`,
	}
	for _, s := range areaStmts {
		if _, err := tx.Exec(ctx, s, geohash5); err != nil {
			return fmt.Errorf("stats: %w", err)
		}
	}
	// Every location of those chains, wherever it is; only rows whose count changed.
	if _, err := tx.Exec(ctx, `UPDATE places p SET chain_locations = c.n
		FROM (SELECT chain_key, count(*)::int AS n FROM places WHERE chain_key = ANY($1) GROUP BY 1) c
		WHERE p.chain_key = c.chain_key AND p.chain_locations <> c.n`, chains); err != nil {
		return fmt.Errorf("stats: %w", err)
	}
	return tx.Commit(ctx)
}
