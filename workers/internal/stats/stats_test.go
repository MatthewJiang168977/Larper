package stats

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

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

}

// Two refreshes of different areas that share a chain, overlapping so that the first
// counts the chain before a new location commits and writes after the second has
// written the new count. Under READ COMMITTED an UPDATE re-checks its WHERE against a
// newer row version but keeps the count from its own snapshot, so without the
// refresh lock the first one overwrites the right count with its stale one.
//
// The interleaving is forced: a third transaction holds one place's row lock, so the
// first refresh stops inside its UPDATE, after its snapshot; that place already holds
// the final count, so the second refresh never needs its lock. Unlike the test above
// this one has to commit (the transactions must see each other), so it uses its own
// chain in empty Southern Ocean areas and deletes everything it made.
func TestRecomputeConcurrentRefreshesOfOneChain(t *testing.T) {
	if testPool == nil {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	const chain = "stats-race-chain"
	var areas []string
	cleanup := func() {
		testPool.Exec(ctx, `DELETE FROM places WHERE overture_id LIKE 'stats-race-%'`)
		testPool.Exec(ctx, `DELETE FROM area_stats WHERE left(geohash6, 5) = ANY($1)`, areas)
		testPool.Exec(ctx, `DELETE FROM area_totals WHERE left(geohash6, 5) = ANY($1)`, areas)
	}
	cleanup()
	t.Cleanup(cleanup)

	add := func(key string, lat, lng float64, locations int) string {
		t.Helper()
		var area string
		if err := testPool.QueryRow(ctx, `
			INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence, chain_locations)
			VALUES ($1, $1, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, '{test}', $4, '{}',
			        array_fill(0::real, ARRAY[160])::vector, 1, $5)
			RETURNING left(geohash6, 5)`,
			"stats-race-"+key, lat, lng, chain, locations).Scan(&area); err != nil {
			t.Fatal(err)
		}
		return area
	}
	// Three locations now (two in area x, one in y); c1 already holds the count the
	// chain will have once the fourth location lands.
	x := add("c1", -60.001, 0.001, 4)
	add("c2", -60.002, 0.002, 3)
	y := add("c3", -61.001, 5.001, 3)
	areas = []string{x, y}
	if x == y {
		t.Fatalf("test places should span two geohash5 areas, both are in %s", x)
	}

	hold, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer hold.Rollback(ctx)
	if _, err := hold.Exec(ctx, `SELECT 1 FROM places WHERE overture_id = 'stats-race-c1' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}

	first := make(chan error, 1)
	go func() { first <- Recompute(ctx, testPool, []string{x}) }()
	waitUntil(t, ctx, "the first refresh waiting on c1's row lock inside its UPDATE",
		`SELECT count(*) > 0 FROM pg_stat_activity
		 WHERE wait_event IN ('transactionid', 'tuple') AND query LIKE 'UPDATE places p SET chain_locations%'`)

	add("c4", -61.002, 5.002, 1) // the fourth location, in area y, committed
	second := make(chan error, 1)
	go func() { second <- Recompute(ctx, testPool, []string{y}) }()
	// Unserialized, the second refresh finishes now; serialized, it waits for the first
	// (on the refresh lock, or on any lock the first holds).
	deadline := time.Now().Add(10 * time.Second)
	for settled := false; !settled; {
		select {
		case err := <-second:
			second <- err
			settled = true
		case <-time.After(100 * time.Millisecond):
			var on string
			testPool.QueryRow(ctx, `SELECT coalesce(min(wait_event), '') FROM pg_stat_activity
				WHERE wait_event_type = 'Lock' AND query NOT LIKE 'UPDATE places p SET chain_locations%'`).Scan(&on)
			if settled = on != ""; settled {
				t.Logf("second refresh waits for the first (lock: %s)", on)
			}
			if !settled && time.Now().After(deadline) {
				t.Fatal("the second refresh neither finished nor waited on the first")
			}
		}
	}

	if err := hold.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	for name, ch := range map[string]chan error{"first": first, "second": second} {
		select {
		case err := <-ch:
			if err != nil {
				t.Fatalf("%s refresh: %v", name, err)
			}
		case <-time.After(30 * time.Second):
			t.Fatalf("%s refresh didn't finish", name)
		}
	}

	rows, err := testPool.Query(ctx, `SELECT overture_id, chain_locations FROM places WHERE chain_key = $1 ORDER BY 1`, chain)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			t.Fatal(err)
		}
		if n != 4 {
			t.Errorf("%s: chain_locations = %d, want 4 (lost update)", id, n)
		}
	}
	var live int
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM places WHERE chain_key = $1`, chain).Scan(&live); err != nil || live != 4 {
		t.Errorf("live count = %d (err %v), want 4", live, err)
	}
}

// The tests above use a handful of places. These two refresh real areas of the NYC
// data at full size, the way the ingest-worker and the bulk loader do, because the
// per-chain advisory locks the small tests were happy with (one per chain, a few
// each) didn't fit there: Postgres's lock table holds about max_locks_per_transaction
// x max_connections entries (6400 by default). Midtown's ~11k chains squeezed into
// spare shared memory; a full NYC load's ~70k failed with "out of shared memory".
// A refresh now holds a single advisory lock, whatever its size. Both run in a
// transaction that is rolled back, so they change nothing; both skip without the
// NYC data.

// Midtown Manhattan, the geohash5 area with the most chains.
const denseArea = "dr5ru"

func TestRecomputeDenseArea(t *testing.T) {
	if testPool == nil {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	var chains int
	if err := testPool.QueryRow(ctx, `SELECT count(DISTINCT chain_key) FROM places WHERE left(geohash6, 5) = $1`,
		denseArea).Scan(&chains); err != nil {
		t.Fatal(err)
	}
	if chains < 5000 {
		t.Skipf("needs the NYC places (%s has %d chains)", denseArea, chains)
	}
	t.Logf("%s: %d chains", denseArea, chains)
	refreshAtScale(t, []string{denseArea})
}

func TestRecomputeAllAreas(t *testing.T) {
	if testPool == nil {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	var areas []string
	var chains int
	if err := testPool.QueryRow(ctx, `SELECT array_agg(DISTINCT left(geohash6, 5)), count(DISTINCT chain_key) FROM places`).
		Scan(&areas, &chains); err != nil {
		t.Fatal(err)
	}
	if chains < 20000 {
		t.Skipf("needs the NYC places (%d chains)", chains)
	}
	t.Logf("%d areas, %d chains: what a full NYC bulk load refreshes", len(areas), chains)
	refreshAtScale(t, areas)
}

// refreshAtScale runs Recompute for the areas in a transaction it rolls back, and
// checks that it took one advisory lock and left every place's chain_locations equal
// to a live count.
func refreshAtScale(t *testing.T, areas []string) {
	t.Helper()
	ctx := context.Background()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)

	start := time.Now()
	if err := Recompute(ctx, tx, areas); err != nil {
		t.Fatalf("Recompute: %v", err)
	}
	t.Logf("refresh took %v", time.Since(start).Round(time.Millisecond))

	var locks int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`).
		Scan(&locks); err != nil {
		t.Fatal(err)
	}
	if locks > 1 {
		t.Errorf("refresh holds %d advisory locks, want at most 1", locks)
	}
	var stale int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM places p
		JOIN (SELECT chain_key, count(*)::int AS live FROM places GROUP BY 1) c USING (chain_key)
		WHERE left(p.geohash6, 5) = ANY($1) AND p.chain_locations <> c.live`, areas).Scan(&stale); err != nil {
		t.Fatal(err)
	}
	if stale != 0 {
		t.Errorf("%d places in the refreshed areas have a chain_locations that differs from a live count", stale)
	}
}

// waitUntil polls a boolean query until it's true, or fails the test after 10 s.
func waitUntil(t *testing.T, ctx context.Context, what, query string) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		var ok bool
		if err := testPool.QueryRow(ctx, query).Scan(&ok); err != nil {
			t.Fatal(err)
		}
		if ok {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}
