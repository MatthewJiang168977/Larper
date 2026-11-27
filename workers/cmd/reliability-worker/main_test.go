package main

import (
	"context"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	eventsv1 "github.com/MatthewJiang168977/larper/workers/gen/larper/events/v1"
)

// The handler against a real Postgres with the migrations applied, as the worker's role:
//
//	TEST_DATABASE_URL=postgres://larper_reliability... TEST_OWNER_DATABASE_URL=postgres://larper... \
//	  go test ./cmd/reliability-worker/
//
// Fixtures and cleanup are the owner's. Skipped without both.
func testPools(t *testing.T) (worker, owner *pgxpool.Pool) {
	t.Helper()
	wURL, oURL := os.Getenv("TEST_DATABASE_URL"), os.Getenv("TEST_OWNER_DATABASE_URL")
	if wURL == "" || oURL == "" {
		t.Skip("TEST_DATABASE_URL and TEST_OWNER_DATABASE_URL not set")
	}
	ctx := context.Background()
	worker, err := pgxpool.New(ctx, wURL)
	if err != nil {
		t.Fatal(err)
	}
	owner, err = pgxpool.New(ctx, oURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { worker.Close(); owner.Close() })
	return worker, owner
}

func one[T any](t *testing.T, db *pgxpool.Pool, sql string, args ...any) T {
	t.Helper()
	var v T
	if err := db.QueryRow(context.Background(), sql, args...).Scan(&v); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return v
}

func place(t *testing.T, owner *pgxpool.Pool) int64 {
	t.Helper()
	vec := "[1" + strings.Repeat(",0", 159) + "]"
	id := one[int64](t, owner,
		`INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
		 VALUES ('test-reliability-' || gen_random_uuid(), 'Reliability Test', ST_SetSRID(ST_MakePoint(0, -60), 4326)::geography,
		         '{test}', 'test-reliability', '{test}', $1::vector, 1) RETURNING id`, vec)
	t.Cleanup(func() { owner.Exec(context.Background(), `DELETE FROM places WHERE id = $1`, id) })
	return id
}

// visit is a user with a completed quest at the place.
func visit(t *testing.T, owner *pgxpool.Pool, placeID int64) (user, quest int64) {
	t.Helper()
	user = one[int64](t, owner, `INSERT INTO users (clerk_id) VALUES ('test_reliability_' || gen_random_uuid()) RETURNING id`)
	t.Cleanup(func() { owner.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, user) })
	quest = one[int64](t, owner,
		`INSERT INTO quests (user_id, place_id, status, score, reasons) VALUES ($1, $2, 'completed', 1, '{}') RETURNING id`,
		user, placeID)
	return user, quest
}

func record(t *testing.T, kind eventsv1.PlaceReportKind, user, quest, placeID int64) *kgo.Record {
	t.Helper()
	evt := &eventsv1.PlaceReport{
		EventId: uuid.NewString(), PlaceId: strconv.FormatInt(placeID, 10), Kind: kind,
		OccurredAt: timestamppb.New(time.Now()),
	}
	if user != 0 {
		evt.UserId, evt.QuestId = strconv.FormatInt(user, 10), strconv.FormatInt(quest, 10)
	}
	b, err := proto.Marshal(evt)
	if err != nil {
		t.Fatal(err)
	}
	return &kgo.Record{Value: b, Headers: []kgo.RecordHeader{{Key: "type", Value: []byte(reportType)}}}
}

const (
	wasnt    = eventsv1.PlaceReportKind_PLACE_REPORT_KIND_WASNT_OPEN
	verified = eventsv1.PlaceReportKind_PLACE_REPORT_KIND_HAND_VERIFIED
)

func apply(t *testing.T, db *pgxpool.Pool, r *kgo.Record, want outcome) {
	t.Helper()
	got, err := handle(context.Background(), db, r)
	if err != nil || got != want {
		t.Fatalf("handle: %v %v, want %v", got, err, want)
	}
}

func suspended(t *testing.T, owner *pgxpool.Pool, placeID int64) bool {
	return one[bool](t, owner, `SELECT suspended_at IS NOT NULL FROM place_reliability WHERE place_id = $1`, placeID)
}

func TestReportsSuspendAndReplaysChangeNothing(t *testing.T) {
	db, owner := testPools(t)
	p := place(t, owner)
	u1, q1 := visit(t, owner, p)
	u2, q2 := visit(t, owner, p)
	first, second := record(t, wasnt, u1, q1, p), record(t, wasnt, u2, q2, p)
	apply(t, db, first, applied)
	if suspended(t, owner, p) {
		t.Fatal("one report suspended")
	}
	apply(t, db, second, applied)
	if !suspended(t, owner, p) {
		t.Fatal("two reports did not suspend")
	}
	before := one[string](t, owner, `SELECT (successes, failures, as_of, suspended_at)::text FROM place_reliability WHERE place_id = $1`, p)
	apply(t, db, first, duplicate)
	apply(t, db, second, duplicate)
	if after := one[string](t, owner, `SELECT (successes, failures, as_of, suspended_at)::text FROM place_reliability WHERE place_id = $1`, p); after != before {
		t.Fatalf("a replay changed the row: %s -> %s", before, after)
	}
	apply(t, db, record(t, verified, 0, 0, p), applied)
	if suspended(t, owner, p) {
		t.Fatal("verification did not lift")
	}
}

func TestConcurrentReportsAreNotLost(t *testing.T) {
	db, owner := testPools(t)
	for range 5 {
		p := place(t, owner)
		var records []*kgo.Record
		for range 2 {
			u, q := visit(t, owner, p)
			records = append(records, record(t, wasnt, u, q, p))
		}
		var wg sync.WaitGroup
		for _, r := range records {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, err := handle(context.Background(), db, r); err != nil {
					t.Error(err)
				}
			}()
		}
		wg.Wait()
		if !suspended(t, owner, p) {
			t.Fatal("a concurrent report was lost")
		}
	}
}

func TestDeletedHistoryAddsNoEvidenceAndSweepRecomputes(t *testing.T) {
	db, owner := testPools(t)
	ctx := context.Background()
	p := place(t, owner)
	u, q := visit(t, owner, p)
	apply(t, db, record(t, wasnt, u, q, p), applied)

	inFlight := record(t, wasnt, u, q, p)
	if _, err := owner.Exec(ctx, `SELECT delete_my_history($1)`, u); err != nil {
		t.Fatal(err)
	}
	if n := one[int](t, owner, `SELECT count(*) FROM place_reports WHERE place_id = $1`, p); n != 0 {
		t.Fatalf("%d reports left after deletion", n)
	}
	apply(t, db, inFlight, ignored)
	if n := one[int](t, owner, `SELECT count(*) FROM place_reports WHERE place_id = $1`, p); n != 0 {
		t.Fatal("an event in flight brought deleted evidence back")
	}
	if !one[bool](t, owner, `SELECT stale FROM place_reliability WHERE place_id = $1`, p) {
		t.Fatal("not marked stale")
	}
	if _, err := sweep(ctx, db); err != nil {
		t.Fatal(err)
	}
	if one[bool](t, owner, `SELECT stale OR failures <> 0 FROM place_reliability WHERE place_id = $1`, p) {
		t.Fatal("sweep did not recompute")
	}
}

func TestOtherTypesAndMissingPlacesAreIgnored(t *testing.T) {
	db, _ := testPools(t)
	apply(t, db, &kgo.Record{Headers: []kgo.RecordHeader{{Key: "type", Value: []byte("larper.events.v1.QuestEvent")}}}, ignored)
	apply(t, db, record(t, verified, 0, 0, 999_999_999_999), ignored)
}
