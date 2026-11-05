package platform

// Sentry for the workers: every Error-level log line becomes a Sentry event (errors
// only, no tracing). Off without SENTRY_DSN (local, tests, k3d, CI): nothing is sent.
//
// What leaves: the log message and its attributes, scrubbed by the same rules as
// apps/api/src/sentry/scrub.ts and apps/web/lib/sentry-scrub.ts (change all three
// together): no emails, tokens or Clerk IDs, no coordinates, no quest or place IDs, no
// query strings. Keys like lat, place_id or bbox are dropped whatever their value.
// The key list is the TypeScript one plus workerOnlyDropKeys; sentry_test.go checks
// that against the API's file.

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/getsentry/sentry-go"
)

const filtered = "[Filtered]"

// The TypeScript scrubbers' list, in the same order.
var sharedDropKeys = []string{
	"cookie", "cookies", "set-cookie", "authorization", "x-clerk-auth-token",
	"email", "emailaddress", "token", "ticket", "password", "secret",
	"lat", "lng", "lon", "latitude", "longitude", "accuracy", "accuracym", "coords", "coordinates", "bbox",
	"placeid", "questid", "place", "placename", "address", "userid",
	"ip", "ipaddress", "clientip", "query", "querystring",
}

// Only here: a place's name, should a loader ever log one under "name" (none does
// yet). The TypeScript scrubbers can't drop it: Sentry's own event fields use "name"
// (sdk.name, os.name).
var workerOnlyDropKeys = []string{"name"}

// Compared lowercased, without _ and -, whole or by their last dotted part.
var dropKeys = map[string]bool{}

func init() {
	for _, k := range append(append([]string{}, sharedDropKeys...), workerOnlyDropKeys...) {
		dropKeys[normalizeKey(k)] = true
	}
}

func normalizeKey(k string) string {
	return strings.NewReplacer("_", "", "-", "").Replace(strings.ToLower(k))
}

func isDropped(key string) bool {
	k := normalizeKey(key)
	return dropKeys[k] || dropKeys[k[strings.LastIndex(k, ".")+1:]]
}

var scrubPatterns = []struct {
	re *regexp.Regexp
	to string
}{
	// Query strings: https://x/quests/today?lat=1&lng=2 -> https://x/quests/today.
	{regexp.MustCompile(`\?[A-Za-z0-9_.~%+-]+=[^\s#"']*`), ""},
	{regexp.MustCompile(`\b(sess|user|client|sms|idn|org|ins|sk_test|sk_live|pk_test|pk_live)_[A-Za-z0-9]{8,}\b`), "${1}_[Filtered]"},
	{regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+`), "[JWT]"},
	{regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+`), "Bearer [Filtered]"},
	{regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`), "[email]"},
	{regexp.MustCompile(`(?i)\b(lat|lng|lon|latitude|longitude|accuracy)=[^&#\s]*`), "${1}=[Filtered]"},
	{regexp.MustCompile(`-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}`), "[coords]"},
	{regexp.MustCompile(`/(quests|places)/\d+`), "/${1}/:id"},
}

// ScrubString removes emails, tokens, coordinates, quest/place IDs and query strings from s.
func ScrubString(s string) string {
	for _, p := range scrubPatterns {
		s = p.re.ReplaceAllString(s, p.to)
	}
	return s
}

// scrubAttr is one attribute's value as it may be sent: dropped keys filtered,
// strings scrubbed, groups flattened into a map.
func scrubAttr(a slog.Attr) any {
	if isDropped(a.Key) {
		return filtered
	}
	v := a.Value.Resolve()
	switch v.Kind() {
	case slog.KindGroup:
		m := map[string]any{}
		for _, g := range v.Group() {
			m[g.Key] = scrubAttr(g)
		}
		return m
	case slog.KindString:
		return ScrubString(v.String())
	case slog.KindAny:
		if err, ok := v.Any().(error); ok {
			return ScrubString(err.Error())
		}
		return ScrubString(fmt.Sprint(v.Any()))
	default:
		return v.Any()
	}
}

// sentryHandler passes every record on to next, and sends Error-level ones to Sentry.
type sentryHandler struct {
	next  slog.Handler
	hub   *sentry.Hub
	attrs []slog.Attr
}

func (h *sentryHandler) Enabled(ctx context.Context, l slog.Level) bool {
	return h.next.Enabled(ctx, l)
}

func (h *sentryHandler) Handle(ctx context.Context, r slog.Record) error {
	if r.Level >= slog.LevelError {
		h.hub.CaptureEvent(h.event(r))
	}
	return h.next.Handle(ctx, r)
}

func (h *sentryHandler) WithAttrs(as []slog.Attr) slog.Handler {
	return &sentryHandler{next: h.next.WithAttrs(as), hub: h.hub, attrs: append(append([]slog.Attr{}, h.attrs...), as...)}
}

// Groups aren't used by the workers; the attributes stay ungrouped in Sentry.
func (h *sentryHandler) WithGroup(name string) slog.Handler {
	return &sentryHandler{next: h.next.WithGroup(name), hub: h.hub, attrs: h.attrs}
}

func (h *sentryHandler) event(r slog.Record) *sentry.Event {
	e := sentry.NewEvent()
	e.Level = sentry.LevelError
	e.Timestamp = r.Time
	e.Message = ScrubString(r.Message)
	extra := map[string]any{}
	if e.Contexts == nil {
		e.Contexts = map[string]sentry.Context{}
	}
	e.Contexts["log"] = extra
	if e.Tags == nil {
		e.Tags = map[string]string{}
	}
	add := func(a slog.Attr) bool {
		if a.Key == "service" {
			e.Tags["service"] = a.Value.String()
		} else {
			extra[a.Key] = scrubAttr(a)
		}
		return true
	}
	for _, a := range h.attrs {
		add(a)
	}
	r.Attrs(add)
	// Grouped by worker and log message only: the error text below varies (addresses,
	// ports, row counts), and Sentry's default grouping would make one issue per variant.
	e.Fingerprint = []string{e.Tags["service"], e.Message}
	// The error is the most useful line in the Sentry list: "postgres: dial tcp ...".
	if err, ok := extra["err"].(string); ok {
		e.Message += ": " + err
	}
	return e
}

func sentryOptions(dsn, release, environment string) sentry.ClientOptions {
	return sentry.ClientOptions{
		Dsn:            dsn,
		Release:        release,
		Environment:    environment,
		SendDefaultPII: false,
		// Last line of defence for anything built outside the handler.
		BeforeSend: func(e *sentry.Event, _ *sentry.EventHint) *sentry.Event {
			e.User = sentry.User{}
			e.Request = nil
			e.Message = ScrubString(e.Message)
			for i := range e.Exception {
				e.Exception[i].Value = ScrubString(e.Exception[i].Value)
			}
			return e
		},
	}
}

// withSentry wraps next when SENTRY_DSN is set; otherwise it returns next unchanged.
func withSentry(next slog.Handler) slog.Handler {
	dsn := Env("SENTRY_DSN", "")
	if dsn == "" {
		return next
	}
	if err := sentry.Init(sentryOptions(dsn, Env("SENTRY_RELEASE", ""), Env("SENTRY_ENVIRONMENT", "development"))); err != nil {
		slog.New(next).Warn("sentry disabled", "err", err)
		return next
	}
	return &sentryHandler{next: next, hub: sentry.CurrentHub()}
}

// FlushSentry waits briefly for queued events to be sent: call it before exiting.
func FlushSentry() {
	sentry.Flush(2 * time.Second)
}
