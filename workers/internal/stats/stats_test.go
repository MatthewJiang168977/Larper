package stats

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Integration test against a real Postgres with PostGIS, pgvector and the migrations
// applied (the stack's own database works: everything happens in a transaction that
// is rolled back, in empty Southern Ocean areas):
//
//	TEST_DATABASE_URL=postgres://... go test ./internal/stats/
var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	if url := os.Getenv("TEST_DATABASE_URL"); url != "" {
		pool, err := pgxpool.New(context.Background(), url)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		testPool = pool
	}
	code := m.Run()
	if testPool != nil {
		testPool.Close()
	}
	os.Exit(code)
}

func TestRecomputeChainLocations(t *testing.T) {
	if testPool == nil {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)

	// Chain a: two places in the refreshed area, one in another area. Chain b: one
	// place in the refreshed area. Chain c: only in the other area, with a stale count
	// that a refresh of the first area must leave alone.
	add := func(key, chain string, lat, lng float64, locations int) {
		t.Helper()
		if _, err := tx.Exec(ctx, `
			INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence, chain_locations)
			VALUES ($1, $1, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, '{test}', $4, '{}',
			        array_fill(0::real, ARRAY[160])::vector, 1, $5)`,
			"stats-test-"+key, lat, lng, chain, locations); err != nil {
			t.Fatal(err)
		}
	}
	add("a1", "stats-test-chain-a", -60.001, 0.001, 1)
	add("a2", "stats-test-chain-a", -60.002, 0.002, 1)
	add("a3", "stats-test-chain-a", -61.001, 5.001, 1)
	add("b1", "stats-test-chain-b", -60.003, 0.003, 1)
	add("c1", "stats-test-chain-c", -61.002, 5.002, 7)

	var area, other string
	if err := tx.QueryRow(ctx, `SELECT left(geohash6, 5) FROM places WHERE overture_id = 'stats-test-a1'`).Scan(&area); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `SELECT left(geohash6, 5) FROM places WHERE overture_id = 'stats-test-a3'`).Scan(&other); err != nil {
		t.Fatal(err)
	}
	if area == other {
		t.Fatalf("test places should span two geohash5 areas, both are in %s", area)
	}

	if err := Recompute(ctx, tx, []string{area}); err != nil {
		t.Fatal(err)
	}

	want := map[string]int{"a1": 3, "a2": 3, "a3": 3, "b1": 1, "c1": 7}
	rows, err := tx.Query(ctx, `SELECT substr(overture_id, 12), chain_locations FROM places WHERE overture_id LIKE 'stats-test-%'`)
	if err != nil {
		t.Fatal(err)
	}
	got, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (struct {
		Key string
		N   int
	}, error) {
		var v struct {
			Key string
			N   int
		}
		err := r.Scan(&v.Key, &v.N)
		return v, err
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(want) {
		t.Fatalf("got %d test places, want %d", len(got), len(want))
	}
	for _, g := range got {
		if g.N != want[g.Key] {
			t.Errorf("place %s: chain_locations = %d, want %d", g.Key, g.N, want[g.Key])
		}
	}

	// chain_stats still agrees, for API pods that read it until it's dropped.
	var a int
	if err := tx.QueryRow(ctx, `SELECT locations FROM chain_stats WHERE chain_key = 'stats-test-chain-a'`).Scan(&a); err != nil || a != 3 {
		t.Errorf("chain_stats for chain a = %d (err %v), want 3", a, err)
	}
}
