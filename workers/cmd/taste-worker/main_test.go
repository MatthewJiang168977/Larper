package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"
	"google.golang.org/protobuf/proto"

	eventsv1 "github.com/MatthewJiang168977/larper/workers/gen/larper/events/v1"
)

func TestUserGone(t *testing.T) {
	fk := &pgconn.PgError{Code: "23503", TableName: "taste_profiles"}
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"the profile's foreign key", fk, true},
		{"wrapped", fmt.Errorf("insert: %w", fk), true},
		{"another table's foreign key", &pgconn.PgError{Code: "23503", TableName: "quests"}, false},
		{"another violation", &pgconn.PgError{Code: "23505", TableName: "taste_profiles"}, false},
		{"not a Postgres error", errors.New("connection reset"), false},
		{"nil", nil, false},
	}
	for _, c := range cases {
		if got := userGone(c.err); got != c.want {
			t.Errorf("%s: userGone = %v, want %v", c.name, got, c.want)
		}
	}
}

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

func record(t *testing.T, userID, placeID string, action eventsv1.QuestAction) (*kgo.Record, string) {
	t.Helper()
	id := uuid.NewString()
	b, err := proto.Marshal(&eventsv1.QuestEvent{EventId: id, UserId: userID, QuestId: "1", PlaceId: placeID, Action: action})
	if err != nil {
		t.Fatal(err)
	}
	return &kgo.Record{Value: b, Headers: []kgo.RecordHeader{{Key: "type", Value: []byte(questType)}}}, id
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
	if _, err := owner.Exec(ctx, `DELETE FROM users WHERE id = $1::bigint`, userID); err != nil {
		t.Fatal(err)
	}

	for _, action := range []eventsv1.QuestAction{
		eventsv1.QuestAction_QUEST_ACTION_ACCEPTED,
		eventsv1.QuestAction_QUEST_ACTION_COMPLETED,
		eventsv1.QuestAction_QUEST_ACTION_SKIPPED,
	} {
		r, eventID := record(t, userID, placeID, action)
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

	r, eventID := record(t, userID, placeID, eventsv1.QuestAction_QUEST_ACTION_COMPLETED)
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
