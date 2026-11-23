package platform

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"
)

// recorder keeps each log record's level and message.
type recorder struct{ recs []slog.Record }

func (r *recorder) Enabled(context.Context, slog.Level) bool { return true }
func (r *recorder) Handle(_ context.Context, rec slog.Record) error {
	r.recs = append(r.recs, rec)
	return nil
}
func (r *recorder) WithAttrs([]slog.Attr) slog.Handler { return r }
func (r *recorder) WithGroup(string) slog.Handler      { return r }

func (r *recorder) levels() (warn, errs, info int) {
	for _, rec := range r.recs {
		switch rec.Level {
		case slog.LevelWarn:
			warn++
		case slog.LevelError:
			errs++
		case slog.LevelInfo:
			info++
		}
	}
	return
}

func TestOutageWarnsUntilAfterThenOneErrorThenRecovers(t *testing.T) {
	rec := &recorder{}
	log := slog.New(rec)
	now := time.Date(2026, 11, 14, 4, 30, 0, 0, time.UTC)
	o := &Outage{Name: "relay batch", After: 2 * time.Minute, now: func() time.Time { return now }, jitter: func() float64 { return 1 }}
	boom := errors.New("dial tcp 10.43.0.12:5432: connect: connection refused")

	// A restart that lasts under two minutes: warnings only, so nothing reaches Sentry.
	for i := 0; i < 5; i++ {
		o.Fail(log, boom)
		now = now.Add(20 * time.Second)
	}
	if w, e, _ := rec.levels(); w != 5 || e != 0 {
		t.Fatalf("short outage: warn %d error %d", w, e)
	}
	o.OK(log)
	if _, _, i := rec.levels(); i != 0 {
		t.Fatal("an unreported outage should recover silently")
	}

	// A long one: exactly one Error once it has lasted After, however long it goes on.
	rec.recs = nil
	for i := 0; i < 20; i++ {
		o.Fail(log, boom)
		now = now.Add(15 * time.Second)
	}
	if w, e, _ := rec.levels(); e != 1 || w != 19 {
		t.Fatalf("long outage: warn %d error %d", w, e)
	}
	for _, r := range rec.recs {
		if r.Level == slog.LevelError && r.Message != "relay batch failing" {
			t.Fatalf("error message %q: must be fixed per loop, so Sentry groups it", r.Message)
		}
	}
	o.OK(log)
	if _, _, i := rec.levels(); i != 1 {
		t.Fatal("a reported outage logs one recovery")
	}

	// And the next outage starts from scratch.
	rec.recs = nil
	o.Fail(log, boom)
	if w, e, _ := rec.levels(); w != 1 || e != 0 {
		t.Fatalf("after recovery: warn %d error %d", w, e)
	}
}

func TestOutageBacksOffFromMinToMax(t *testing.T) {
	log := slog.New(&recorder{})
	o := &Outage{Name: "claim", jitter: func() float64 { return 1 }} // defaults: 2s to 30s
	var got []time.Duration
	for i := 0; i < 7; i++ {
		got = append(got, o.Fail(log, errors.New("x")))
	}
	want := []time.Duration{2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second, 30 * time.Second, 30 * time.Second}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("waits %v, want %v", got, want)
		}
	}
	o.OK(log)
	if d := o.Fail(log, errors.New("x")); d != 2*time.Second {
		t.Fatalf("after recovery the wait starts again at Min, got %v", d)
	}
}

func TestOutageJitterStaysWithinTheStep(t *testing.T) {
	log := slog.New(&recorder{})
	o := &Outage{Name: "dispatch", Min: 5 * time.Second, Max: 5 * time.Second, jitter: func() float64 { return 0 }}
	if d := o.Fail(log, errors.New("x")); d != 4*time.Second {
		t.Fatalf("lowest jitter = %v, want 80%% of 5s", d)
	}
}
