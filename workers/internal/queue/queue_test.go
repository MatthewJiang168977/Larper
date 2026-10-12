package queue

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestBackoff(t *testing.T) {
	cases := map[int]time.Duration{1: 5 * time.Second, 2: 10 * time.Second, 3: 20 * time.Second, 20: 5 * time.Minute}
	for attempt, want := range cases {
		if got := Backoff(attempt); got != want {
			t.Errorf("Backoff(%d) = %v, want %v", attempt, got, want)
		}
	}
}

// Integration tests run against a real Postgres with the migrations applied:
//
//	TEST_DATABASE_URL=postgres://... go test ./internal/queue/
//
// One pool for the package (connections are reused across tests), and each test
// uses its own queue name, so they never touch real jobs.
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

func testQueue(t *testing.T) (Postgres, string) {
	t.Helper()
	if testPool == nil {
		t.Skip("TEST_DATABASE_URL not set")
	}
	name := fmt.Sprintf("test-%s-%d", t.Name(), time.Now().UnixNano())
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM jobs WHERE queue = $1`, name) })
	return Postgres{Pool: testPool}, name
}

func enqueue(t *testing.T, q Postgres, queue, key string, maxAttempts int) {
	t.Helper()
	_, err := q.Pool.Exec(context.Background(),
		`INSERT INTO jobs (queue, dedupe_key, payload, max_attempts) VALUES ($1, $2, '{}', $3)`, queue, key, maxAttempts)
	if err != nil {
		t.Fatal(err)
	}
}

func status(t *testing.T, q Postgres, id int64) (s string, attempts int) {
	t.Helper()
	if err := q.Pool.QueryRow(context.Background(), `SELECT status, attempts FROM jobs WHERE id = $1`, id).Scan(&s, &attempts); err != nil {
		t.Fatal(err)
	}
	return
}

func TestClaimCompleteAndEmpty(t *testing.T) {
	q, name := testQueue(t)
	ctx := context.Background()
	enqueue(t, q, name, "a", 3)

	j, err := q.Claim(ctx, name, time.Minute)
	if err != nil || j == nil || j.Attempt != 1 {
		t.Fatalf("claim: %v %+v", err, j)
	}
	if again, _ := q.Claim(ctx, name, time.Minute); again != nil {
		t.Fatal("a leased job was claimed twice")
	}
	if err := q.Complete(ctx, j); err != nil {
		t.Fatal(err)
	}
	if s, _ := status(t, q, j.ID); s != "done" {
		t.Fatalf("status = %s", s)
	}
}

func TestDedupeOneLiveJobPerKey(t *testing.T) {
	q, name := testQueue(t)
	enqueue(t, q, name, "same", 3)
	_, err := q.Pool.Exec(context.Background(),
		`INSERT INTO jobs (queue, dedupe_key, payload) VALUES ($1, 'same', '{}')`, name)
	if err == nil {
		t.Fatal("second live job with the same key was accepted")
	}
}

// The worker died: its lease lapses, another worker gets the job (redelivery),
// and the dead worker's late Complete is fenced off.
func TestLapsedLeaseIsRedeliveredAndFenced(t *testing.T) {
	q, name := testQueue(t)
	ctx := context.Background()
	enqueue(t, q, name, "k", 3)

	first, _ := q.Claim(ctx, name, 50*time.Millisecond)
	time.Sleep(150 * time.Millisecond)
	second, err := q.Claim(ctx, name, time.Minute)
	if err != nil || second == nil || second.ID != first.ID || second.Attempt != 2 {
		t.Fatalf("redelivery: %v %+v", err, second)
	}
	if err := q.Complete(ctx, first); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale worker's Complete: %v, want ErrLeaseLost", err)
	}
	if err := q.Complete(ctx, second); err != nil {
		t.Fatal(err)
	}
}

func TestFailRetriesWithBackoffThenDeadLetters(t *testing.T) {
	q, name := testQueue(t)
	ctx := context.Background()
	enqueue(t, q, name, "k", 2)

	j, _ := q.Claim(ctx, name, time.Minute)
	if err := q.Fail(ctx, j, errors.New("boom"), false); err != nil {
		t.Fatal(err)
	}
	if s, _ := status(t, q, j.ID); s != "queued" {
		t.Fatalf("after first failure: %s, want queued", s)
	}
	if again, _ := q.Claim(ctx, name, time.Minute); again != nil {
		t.Fatal("claimed during backoff")
	}
	// Skip the wait: pretend the backoff elapsed.
	q.Pool.Exec(ctx, `UPDATE jobs SET run_after = now() WHERE id = $1`, j.ID)
	j, _ = q.Claim(ctx, name, time.Minute)
	if err := q.Fail(ctx, j, errors.New("boom again"), false); err != nil {
		t.Fatal(err)
	}
	if s, n := status(t, q, j.ID); s != "dead" || n != 2 {
		t.Fatalf("after max attempts: %s/%d, want dead/2", s, n)
	}
}

func TestPermanentFailureDeadLettersImmediately(t *testing.T) {
	q, name := testQueue(t)
	ctx := context.Background()
	enqueue(t, q, name, "k", 5)
	j, _ := q.Claim(ctx, name, time.Minute)
	if err := q.Fail(ctx, j, errors.New("bad payload"), true); err != nil {
		t.Fatal(err)
	}
	if s, _ := status(t, q, j.ID); s != "dead" {
		t.Fatalf("status = %s, want dead", s)
	}
}

func TestCrashLoopingJobIsDeadLetteredOnClaim(t *testing.T) {
	q, name := testQueue(t)
	ctx := context.Background()
	enqueue(t, q, name, "k", 1)
	j, _ := q.Claim(ctx, name, 50*time.Millisecond) // attempt 1 of 1, then the worker "dies"
	time.Sleep(150 * time.Millisecond)
	if next, err := q.Claim(ctx, name, time.Minute); err != nil || next != nil {
		t.Fatalf("claim after lapsed final attempt: %v %+v, want nothing", err, next)
	}
	if s, _ := status(t, q, j.ID); s != "dead" {
		t.Fatalf("status = %s, want dead", s)
	}
}
