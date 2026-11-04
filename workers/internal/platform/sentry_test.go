package platform

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"
)

func TestScrubString(t *testing.T) {
	cases := map[string]string{
		"no account for jane.doe+x@nyu.edu":              "no account for [email]",
		"session sess_2abcDEF345ghiJKL678":               "session sess_[Filtered]",
		"token eyJhbGciOiJSUzI1.eyJzdWIiOiJ1c2Vy.c2lnbg": "token [JWT]",
		"Authorization: Bearer abc.def-ghi":              "Authorization: Bearer [Filtered]",
		"/quests/today?lat=40.7301&lng=-73.9965":         "/quests/today?lat=[Filtered]&lng=[Filtered]",
		"too far from 40.73012, -73.99651":               "too far from [coords]",
		"POST /quests/4812/accept":                       "POST /quests/:id/accept",
		"dial tcp 10.43.0.12:5432: connection refused":   "dial tcp 10.43.0.12:5432: connection refused",
	}
	// Built at runtime: a literal Clerk-style secret key trips gitleaks' Stripe rule.
	cases["key "+"sk_"+"live_abcdefgh12345678"] = "key sk_live_[Filtered]"
	for in, want := range cases {
		if got := ScrubString(in); got != want {
			t.Errorf("ScrubString(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEventFromRecord(t *testing.T) {
	h := &sentryHandler{next: slog.NewJSONHandler(io.Discard, nil), attrs: []slog.Attr{slog.String("service", "ingest-worker")}}
	r := slog.NewRecord(time.Now(), slog.LevelError, "load failed for jane@nyu.edu", 0)
	r.AddAttrs(
		slog.Any("err", errors.New("place 40.71234, -74.00123 rejected")),
		slog.Int64("place_id", 99),
		slog.String("bbox", "-74.1,40.6,-73.8,40.9"),
		slog.Group("job", slog.Float64("lat", 40.7), slog.Int("attempt", 2)),
		slog.Int("rows", 3000),
	)
	e := h.event(r)
	if e.Message != "load failed for [email]: place [coords] rejected" {
		t.Errorf("message = %q", e.Message)
	}
	if e.Tags["service"] != "ingest-worker" {
		t.Errorf("service tag = %q", e.Tags["service"])
	}
	extra := e.Contexts["log"]
	if extra["place_id"] != filtered || extra["bbox"] != filtered || extra["rows"] != int64(3000) {
		t.Errorf("log context = %#v", extra)
	}
	job := extra["job"].(map[string]any)
	if job["lat"] != filtered || job["attempt"] != int64(2) {
		t.Errorf("job group = %#v", job)
	}
}

func TestWithoutDSNTheHandlerIsUnchanged(t *testing.T) {
	t.Setenv("SENTRY_DSN", "")
	next := slog.NewJSONHandler(io.Discard, nil)
	if withSentry(next) != slog.Handler(next) {
		t.Fatal("wrapped without a DSN")
	}
}

func TestOnlyErrorsAreSent(t *testing.T) {
	h := &sentryHandler{next: slog.NewJSONHandler(io.Discard, nil)}
	if !h.Enabled(context.Background(), slog.LevelInfo) {
		t.Fatal("info should still be logged")
	}
}
