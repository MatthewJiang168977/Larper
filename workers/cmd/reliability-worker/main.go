// reliability-worker consumes PlaceReport events and keeps place_reliability: the estimate
// that each place is open and as described (internal/reliability).
//
// Idempotent and replay-safe: the event id goes into processed_events in the same transaction
// as the report, and the place's row is recomputed from all of its reports, so a redelivery or
// a reordering changes nothing. Reports about one place can arrive on different partitions, so
// a per-place advisory lock serializes them. Like the taste worker, it takes the user -> quest
// lock first, so a report in flight never outlives a history or account deletion.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"
	"google.golang.org/protobuf/proto"

	eventsv1 "github.com/MatthewJiang168977/larper/workers/gen/larper/events/v1"
	"github.com/MatthewJiang168977/larper/workers/internal/platform"
	"github.com/MatthewJiang168977/larper/workers/internal/reliability"
)

const (
	consumer   = "reliability-worker"
	dlqTopic   = platform.UserEventsTopic + ".dlq"
	reportType = "larper.events.v1.PlaceReport"
	sweepEvery = time.Minute
	sweepBatch = 200
)

type outcome string

const (
	applied      outcome = "applied"
	duplicate    outcome = "duplicate"
	ignored      outcome = "ignored"
	deadLettered outcome = "dead-lettered"
	interrupted  outcome = "interrupted"
)

// errPoison marks a record that will never succeed, however often it's retried.
var errPoison = errors.New("poison record")

var kinds = map[eventsv1.PlaceReportKind]reliability.Kind{
	eventsv1.PlaceReportKind_PLACE_REPORT_KIND_CHECKED_IN:     reliability.CheckedIn,
	eventsv1.PlaceReportKind_PLACE_REPORT_KIND_CONFIRMED_OPEN: reliability.ConfirmedOpen,
	eventsv1.PlaceReportKind_PLACE_REPORT_KIND_WASNT_OPEN:     reliability.WasntOpen,
	eventsv1.PlaceReportKind_PLACE_REPORT_KIND_SKIPPED_CLOSED: reliability.SkippedClosed,
	eventsv1.PlaceReportKind_PLACE_REPORT_KIND_HAND_VERIFIED:  reliability.HandVerified,
	eventsv1.PlaceReportKind_PLACE_REPORT_KIND_HAND_CLOSED:    reliability.HandClosed,
}

func main() {
	log := platform.Logger(consumer)
	defer platform.FlushSentry()
	ctx, stop := platform.SignalContext()
	defer stop()

	pool, err := platform.Postgres(ctx)
	if err != nil {
		platform.Fatal(log, "postgres", err)
	}
	defer pool.Close()

	kafka, err := platform.Kafka(
		kgo.ConsumerGroup(consumer),
		kgo.ConsumeTopics(platform.UserEventsTopic),
		kgo.DisableAutoCommit(),
		kgo.BlockRebalanceOnPoll(),
	)
	if err != nil {
		platform.Fatal(log, "kafka", err)
	}
	defer kafka.Close()

	go sweepLoop(ctx, log, pool)

	log.Info("consuming", "topic", platform.UserEventsTopic)
	for ctx.Err() == nil {
		fetches := kafka.PollRecords(ctx, 500)
		if fetches.IsClientClosed() || ctx.Err() != nil {
			break
		}
		fetches.EachError(func(t string, p int32, err error) {
			log.Warn("fetch error", "topic", t, "partition", p, "err", err)
		})
		counts := map[outcome]int{}
		fetches.EachRecord(func(r *kgo.Record) {
			counts[handleWithRetry(ctx, pool, kafka, r)]++
		})
		// Commit only if the whole batch finished; an interrupted batch is replayed.
		if len(counts) > 0 && counts[interrupted] == 0 {
			if err := kafka.CommitUncommittedOffsets(ctx); err != nil {
				log.Error("commit offsets", "err", err)
			}
			if counts[applied]+counts[duplicate]+counts[deadLettered] > 0 {
				log.Info("batch", "applied", counts[applied], "duplicate", counts[duplicate],
					"dead_lettered", counts[deadLettered])
			}
		}
		kafka.AllowRebalance()
	}
	log.Info("stopped")
}

func handleWithRetry(ctx context.Context, pool *pgxpool.Pool, kafka *kgo.Client, r *kgo.Record) outcome {
	backoff := 200 * time.Millisecond
	for {
		out, err := handle(ctx, pool, r)
		if err == nil {
			return out
		}
		if errors.Is(err, errPoison) {
			deadLetter(ctx, kafka, r, err)
			return deadLettered
		}
		if ctx.Err() != nil {
			return interrupted
		}
		slog.Warn("transient failure; retrying", "partition", r.Partition, "offset", r.Offset, "err", err, "backoff", backoff)
		select {
		case <-ctx.Done():
			return interrupted
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 10*time.Second)
	}
}

func handle(ctx context.Context, pool *pgxpool.Pool, r *kgo.Record) (outcome, error) {
	if platform.Header(r, "type") != reportType {
		return ignored, nil // another event type on the topic
	}
	var evt eventsv1.PlaceReport
	if err := proto.Unmarshal(r.Value, &evt); err != nil {
		return "", fmt.Errorf("%w: decode: %v", errPoison, err)
	}
	if _, err := uuid.Parse(evt.EventId); err != nil {
		return "", fmt.Errorf("%w: event_id %q: %v", errPoison, evt.EventId, err)
	}
	placeID, err := strconv.ParseInt(evt.PlaceId, 10, 64)
	if err != nil {
		return "", fmt.Errorf("%w: place_id %q", errPoison, evt.PlaceId)
	}
	if evt.OccurredAt == nil {
		return "", fmt.Errorf("%w: no occurred_at", errPoison)
	}
	kind, ok := kinds[evt.Kind]
	if !ok {
		return ignored, nil // a kind from a newer API
	}
	// A person's report names them and their visit; the curator's verdicts name neither.
	var userID, questID *int64
	if kind != reliability.HandVerified && kind != reliability.HandClosed {
		u, uerr := strconv.ParseInt(evt.UserId, 10, 64)
		q, qerr := strconv.ParseInt(evt.QuestId, 10, 64)
		if uerr != nil || qerr != nil {
			return "", fmt.Errorf("%w: user %q quest %q", errPoison, evt.UserId, evt.QuestId)
		}
		userID, questID = &u, &q
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx,
		`INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, consumer, evt.EventId)
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() == 0 {
		return duplicate, tx.Commit(ctx)
	}
	if userID != nil {
		var present bool
		if err := tx.QueryRow(ctx, `SELECT lock_user_quest($1, $2)`, *userID, *questID).Scan(&present); err != nil {
			return "", err
		}
		if !present {
			return ignored, tx.Commit(ctx) // user or history deleted: no evidence
		}
	}
	if err := lockPlace(ctx, tx, placeID); err != nil {
		return "", err
	}
	// The row first: it also tells whether the place still exists.
	tag, err = tx.Exec(ctx, `INSERT INTO place_reliability (place_id) VALUES ($1) ON CONFLICT DO NOTHING`, placeID)
	if err != nil {
		var pg interface{ SQLState() string }
		if errors.As(err, &pg) && pg.SQLState() == "23503" { // the place is gone
			return ignored, nil
		}
		return "", err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO place_reports (event_id, place_id, user_id, quest_id, kind, occurred_at)
		 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (event_id) DO NOTHING`,
		evt.EventId, placeID, userID, questID, string(kind), evt.OccurredAt.AsTime()); err != nil {
		return "", err
	}
	if err := recompute(ctx, tx, placeID, time.Now()); err != nil {
		return "", err
	}
	return applied, tx.Commit(ctx)
}

func lockPlace(ctx context.Context, tx pgx.Tx, placeID int64) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('place-reliability:' || $1::bigint, 0))`, placeID)
	return err
}

// recompute rewrites the place's row from all its reports. The caller holds the place lock and
// the row exists. The row is locked before the reports are read, so a history deletion (which
// marks the row stale) either commits before the read or marks it stale again afterwards.
func recompute(ctx context.Context, tx pgx.Tx, placeID int64, now time.Time) error {
	var suspended *time.Time
	if err := tx.QueryRow(ctx,
		`SELECT suspended_at FROM place_reliability WHERE place_id = $1 FOR UPDATE`, placeID).Scan(&suspended); err != nil {
		return err
	}
	rows, err := tx.Query(ctx,
		`SELECT event_id::text, kind, coalesce(user_id, 0), coalesce(quest_id, 0), occurred_at
		 FROM place_reports WHERE place_id = $1`, placeID)
	if err != nil {
		return err
	}
	reports, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (reliability.Report, error) {
		var r reliability.Report
		err := row.Scan(&r.ID, &r.Kind, &r.UserID, &r.Visit, &r.At)
		return r, err
	})
	if err != nil {
		return err
	}
	res := reliability.Compute(reports, suspended, now)
	_, err = tx.Exec(ctx,
		`UPDATE place_reliability SET successes = $2, failures = $3, as_of = $4, suspended_at = $5,
		        stale = false, updated_at = now() WHERE place_id = $1`,
		placeID, res.Successes, res.Failures, res.AsOf, res.SuspendedAt)
	return err
}

// sweep recomputes the rows whose evidence changed without an event (a history deletion, the
// migration's backfill). One transaction per place.
func sweep(ctx context.Context, pool *pgxpool.Pool) (int, error) {
	rows, err := pool.Query(ctx, `SELECT place_id FROM place_reliability WHERE stale ORDER BY place_id LIMIT $1`, sweepBatch)
	if err != nil {
		return 0, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return 0, err
	}
	for _, id := range ids {
		err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
			if err := lockPlace(ctx, tx, id); err != nil {
				return err
			}
			return recompute(ctx, tx, id, time.Now())
		})
		if err != nil {
			return 0, err
		}
	}
	return len(ids), nil
}

func sweepLoop(ctx context.Context, log *slog.Logger, pool *pgxpool.Pool) {
	outage := &platform.Outage{Name: "reliability sweep", After: 5 * time.Minute}
	for {
		n, err := sweep(ctx, pool)
		switch {
		case ctx.Err() != nil:
			return
		case err != nil:
			outage.Fail(log, err)
		default:
			outage.OK(log)
			if n > 0 {
				log.Info("recomputed stale places", "places", n)
			}
		}
		wait := sweepEvery
		if n == sweepBatch {
			wait = time.Second // more to do
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

func deadLetter(ctx context.Context, kafka *kgo.Client, r *kgo.Record, cause error) {
	headers := append(append([]kgo.RecordHeader{}, r.Headers...),
		kgo.RecordHeader{Key: "dlq.error", Value: []byte(cause.Error())},
		kgo.RecordHeader{Key: "dlq.source", Value: fmt.Appendf(nil, "%s/%d/%d", r.Topic, r.Partition, r.Offset)},
	)
	dlq := &kgo.Record{Topic: dlqTopic, Key: r.Key, Value: r.Value, Headers: headers}
	if err := kafka.ProduceSync(ctx, dlq).FirstErr(); err != nil {
		slog.Error("dead-letter publish failed", "err", err)
		return
	}
	slog.Warn("dead-lettered", "partition", r.Partition, "offset", r.Offset, "err", cause)
}
