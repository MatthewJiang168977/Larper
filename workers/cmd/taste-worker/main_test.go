package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"
	"google.golang.org/protobuf/proto"

	eventsv1 "github.com/MatthewJiang168977/larper/workers/gen/larper/events/v1"
)

// The handler against a real Postgres with the migrations applied, as the taste-worker's
// role (it can't read users or delete anything):
//
//	TEST_DATABASE_URL=postgres://larper_taste... TEST_OWNER_DATABASE_URL=postgres://larper... \
//	  go test ./cmd/taste-worker/
//
// Fixtures and cleanup are the owner's. Skipped without both.
func testPools(t *testing.T) (taste, owner *pgxpool.Pool) {
	t.Helper()
	tURL, oURL := os.Getenv("TEST_DATABASE_URL"), os.Getenv("TEST_OWNER_DATABASE_URL")
	if tURL == "" || oURL == "" {
		t.Skip("TEST_DATABASE_URL and TEST_OWNER_DATABASE_URL not set")
	}
	ctx := context.Background()
	taste, err := pgxpool.New(ctx, tURL)
	if err != nil {
		t.Fatal(err)
	}
	owner, err = pgxpool.New(ctx, oURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { taste.Close(); owner.Close() })
	return taste, owner
}

func fixtures(t *testing.T, owner *pgxpool.Pool) (userID, placeID string) {
	t.Helper()
	ctx := context.Background()
	if err := owner.QueryRow(ctx,
		`INSERT INTO users (clerk_id) VALUES ('test_taste_' || gen_random_uuid()) RETURNING id::text`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	vec := "[1" + strings.Repeat(",0", 159) + "]"
	if err := owner.QueryRow(ctx,
		`INSERT INTO places (overture_id, name, geom, categories, chain_key, tags, tag_vec, confidence)
		 VALUES ('test-taste-' || gen_random_uuid(), 'Taste Test', ST_SetSRID(ST_MakePoint(0, -60), 4326)::geography,
		         '{test}', 'test-taste', '{test}', $1::vector, 1) RETURNING id::text`, vec).Scan(&placeID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		owner.Exec(ctx, `DELETE FROM users WHERE id = $1::bigint`, userID)
		owner.Exec(ctx, `DELETE FROM places WHERE id = $1::bigint`, placeID)
	})
	return userID, placeID
}

func record(t *testing.T, userID, questID, placeID string, action eventsv1.QuestAction) (*kgo.Record, string) {
	t.Helper()
	id := uuid.NewString()
	b, err := proto.Marshal(&eventsv1.QuestEvent{EventId: id, UserId: userID, QuestId: questID, PlaceId: placeID, Action: action})
	if err != nil {
		t.Fatal(err)
	}
	return &kgo.Record{Value: b, Headers: []kgo.RecordHeader{{Key: "type", Value: []byte(questType)}}}, id
}

func questFixture(t *testing.T, owner *pgxpool.Pool, userID, placeID string) string {
	t.Helper()
	var questID string
	if err := owner.QueryRow(context.Background(), `
		INSERT INTO quests (user_id, place_id, status, score, reasons)
		VALUES ($1::bigint, $2::bigint, 'completed', 1, '{}') RETURNING id::text`, userID, placeID).Scan(&questID); err != nil {
		t.Fatal(err)
	}
	return questID
}

func count(t *testing.T, owner *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := owner.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// An event written before DELETE /me can still be in Kafka after the user is gone. It
// must neither recreate a profile for the deleted user nor fail forever (the worker
// retries a failing record until it succeeds, which would stall the partition).
func TestEventForDeletedUserIsIgnored(t *testing.T) {
	taste, owner := testPools(t)
	ctx := context.Background()
	userID, placeID := fixtures(t, owner)
	questID := questFixture(t, owner, userID, placeID)
	if _, err := owner.Exec(ctx, `DELETE FROM users WHERE id = $1::bigint`, userID); err != nil {
		t.Fatal(err)
	}

	for _, action := range []eventsv1.QuestAction{
		eventsv1.QuestAction_QUEST_ACTION_ACCEPTED,
		eventsv1.QuestAction_QUEST_ACTION_COMPLETED,
		eventsv1.QuestAction_QUEST_ACTION_SKIPPED,
	} {
		r, eventID := record(t, userID, questID, placeID, action)
		out, err := handle(ctx, taste, r)
		if err != nil || out != ignored {
			t.Fatalf("%v: handle = %q, %v; want ignored, nil", action, out, err)
		}
		if n := count(t, owner, `SELECT count(*) FROM taste_profiles WHERE user_id = $1::bigint`, userID); n != 0 {
			t.Fatalf("%v: a taste profile was recreated for the deleted user", action)
		}
		t.Cleanup(func() { owner.Exec(ctx, `DELETE FROM processed_events WHERE event_id = $1::uuid`, eventID) })
	}
}

// The same handler still learns for a user who exists, and a redelivery is a no-op.
func TestEventForExistingUserStillApplies(t *testing.T) {
	taste, owner := testPools(t)
	ctx := context.Background()
	userID, placeID := fixtures(t, owner)

	questID := questFixture(t, owner, userID, placeID)
	r, eventID := record(t, userID, questID, placeID, eventsv1.QuestAction_QUEST_ACTION_COMPLETED)
	t.Cleanup(func() { owner.Exec(ctx, `DELETE FROM processed_events WHERE event_id = $1::uuid`, eventID) })
	if out, err := handle(ctx, taste, r); err != nil || out != applied {
		t.Fatalf("first delivery: handle = %q, %v; want applied, nil", out, err)
	}
	if n := count(t, owner, `SELECT count(*) FROM taste_profiles WHERE user_id = $1::bigint`, userID); n != 1 {
		t.Fatalf("taste profiles = %d, want 1", n)
	}
	if out, err := handle(ctx, taste, r); err != nil || out != duplicate {
		t.Fatalf("redelivery: handle = %q, %v; want duplicate, nil", out, err)
	}
}

func TestEventForAnotherUsersQuestIsIgnored(t *testing.T) {
	taste, owner := testPools(t)
	ctx := context.Background()
	userID, placeID := fixtures(t, owner)
	otherID, _ := fixtures(t, owner)
	questID := questFixture(t, owner, otherID, placeID)
	r, eventID := record(t, userID, questID, placeID, eventsv1.QuestAction_QUEST_ACTION_COMPLETED)
	t.Cleanup(func() { owner.Exec(ctx, `DELETE FROM processed_events WHERE event_id = $1::uuid`, eventID) })
	if out, err := handle(ctx, taste, r); err != nil || out != ignored {
		t.Fatalf("handle = %q, %v; want ignored, nil", out, err)
	}
}

func TestEventRechecksQuestAfterWaitingForHistoryDelete(t *testing.T) {
	taste, owner := testPools(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	userID, placeID := fixtures(t, owner)
	questID := questFixture(t, owner, userID, placeID)
	if _, err := owner.Exec(ctx, `INSERT INTO taste_profiles (user_id, vec, source)
		VALUES ($1::bigint, array_fill(0::real, ARRAY[160])::vector, 'onboarding')`, userID); err != nil {
		t.Fatal(err)
	}
	deleting, err := owner.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer deleting.Rollback(context.Background())
	var pid int32
	if err := deleting.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err := deleting.Exec(ctx, `SELECT delete_my_history($1::bigint)`, userID); err != nil {
		t.Fatal(err)
	}

	r, eventID := record(t, userID, questID, placeID, eventsv1.QuestAction_QUEST_ACTION_COMPLETED)
	type delivery struct {
		out outcome
		err error
	}
	result := make(chan delivery, 1)
	t.Cleanup(func() {
		owner.Exec(context.Background(), `DELETE FROM processed_events WHERE event_id = $1::uuid`, eventID)
	})
	go func() {
		out, err := handle(ctx, taste, r)
		result <- delivery{out, err}
	}()
	for {
		var waiting bool
		err := owner.QueryRow(ctx, `SELECT EXISTS (
			SELECT FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))
		)`, pid).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case got := <-result:
			t.Fatalf("handler finished before history delete committed: %q, %v", got.out, got.err)
		case <-time.After(10 * time.Millisecond):
		}
	}
	if err := deleting.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if got := <-result; got.err != nil || got.out != ignored {
		t.Fatalf("handle after the lock was released = %q, %v; want ignored, nil", got.out, got.err)
	}
	if n := count(t, owner, `SELECT count(*) FROM taste_profiles WHERE user_id = $1::bigint AND source = 'onboarding'`, userID); n != 1 {
		t.Fatal("event changed the retained onboarding profile")
	}
}

// An ignored event is still recorded as processed, so a redelivery is a duplicate rather
// than another lock round trip: the same as the place-gone path.
func TestIgnoredEventsAreRecordedAsProcessed(t *testing.T) {
	taste, owner := testPools(t)
	ctx := context.Background()
	userID, placeID := fixtures(t, owner)
	questID := questFixture(t, owner, userID, placeID)
	if _, err := owner.Exec(ctx, `DELETE FROM quests WHERE id = $1::bigint`, questID); err != nil {
		t.Fatal(err)
	}

	for name, quest := range map[string]string{"quest gone": questID, "unparsable quest id": "not-a-number"} {
		r, eventID := record(t, userID, quest, placeID, eventsv1.QuestAction_QUEST_ACTION_COMPLETED)
		t.Cleanup(func() { owner.Exec(ctx, `DELETE FROM processed_events WHERE event_id = $1::uuid`, eventID) })
		if out, err := handle(ctx, taste, r); err != nil || out != ignored {
			t.Fatalf("%s: handle = %q, %v; want ignored, nil", name, out, err)
		}
		if n := count(t, owner, `SELECT count(*) FROM processed_events WHERE consumer = $1 AND event_id = $2::uuid`, consumer, eventID); n != 1 {
			t.Fatalf("%s: processed_events rows = %d, want 1", name, n)
		}
		if out, err := handle(ctx, taste, r); err != nil || out != duplicate {
			t.Fatalf("%s: redelivery = %q, %v; want duplicate, nil", name, out, err)
		}
	}
}
