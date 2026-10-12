// taste-worker consumes quest events and nudges each user's taste vector toward
// places they accept or visit and away from ones they skip.
//
// Idempotent: the event id goes into processed_events in the same transaction as
// the taste update, so a redelivered event (the relay is at-least-once) is a no-op.
// Offsets are committed only after the DB commit, so a crash replays rather than
// loses work. Records it can't decode go to user.events.dlq instead of blocking the
// partition forever.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"
	"google.golang.org/protobuf/proto"

	eventsv1 "github.com/MatthewJiang168977/larper/workers/gen/larper/events/v1"
	"github.com/MatthewJiang168977/larper/workers/internal/platform"
	"github.com/MatthewJiang168977/larper/workers/internal/taste"
	"github.com/MatthewJiang168977/larper/workers/internal/taxonomy"
)

const (
	consumer  = "taste-worker"
	dlqTopic  = platform.UserEventsTopic + ".dlq"
	questType = "larper.events.v1.QuestEvent"
)

type outcome string

const (
	applied     outcome = "applied"
	duplicate   outcome = "duplicate"
	ignored     outcome = "ignored"
	deadLetterd outcome = "dead-lettered"
	interrupted outcome = "interrupted"
)

// errPoison marks a record that will never succeed, however often it's retried.
var errPoison = errors.New("poison record")

func main() {
	log := platform.Logger(consumer)
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
		// Don't let a rebalance hand our partitions to another replica mid-batch;
		// we finish and commit first (AllowRebalance below).
		kgo.BlockRebalanceOnPoll(),
	)
	if err != nil {
		platform.Fatal(log, "kafka", err)
	}
	defer kafka.Close()

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
			log.Info("batch", "applied", counts[applied], "duplicate", counts[duplicate],
				"ignored", counts[ignored], "dead_lettered", counts[deadLetterd])
		}
		kafka.AllowRebalance()
	}
	log.Info("stopped")
}

// handleWithRetry retries transient failures (DB down, deadlock) with backoff until
// they succeed or we're shutting down. Poison records are dead-lettered once.
func handleWithRetry(ctx context.Context, pool *pgxpool.Pool, kafka *kgo.Client, r *kgo.Record) outcome {
	backoff := 200 * time.Millisecond
	for {
		out, err := handle(ctx, pool, r)
		if err == nil {
			return out
		}
		if errors.Is(err, errPoison) {
			deadLetter(ctx, kafka, r, err)
			return deadLetterd
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
	if t := platform.Header(r, "type"); t != questType {
		return ignored, nil // another event type on the topic; not ours
	}
	var evt eventsv1.QuestEvent
	if err := proto.Unmarshal(r.Value, &evt); err != nil {
		return "", fmt.Errorf("%w: decode: %v", errPoison, err)
	}
	if _, err := uuid.Parse(evt.EventId); err != nil {
		return "", fmt.Errorf("%w: event_id %q: %v", errPoison, evt.EventId, err)
	}
	if _, moves := taste.Step(evt.Action); !moves {
		return ignored, nil
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx,
		`INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		consumer, evt.EventId)
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() == 0 {
		return duplicate, tx.Commit(ctx)
	}

	// Lock the profile row. Two events for one user never race (same partition, one
	// consumer), but onboarding can re-seed the profile at the same moment.
	var oldText *string
	err = tx.QueryRow(ctx, `SELECT vec::text FROM taste_profiles WHERE user_id = $1 FOR UPDATE`, evt.UserId).Scan(&oldText)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	var placeText string
	if err := tx.QueryRow(ctx, `SELECT tag_vec::text FROM places WHERE id = $1`, evt.PlaceId).Scan(&placeText); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ignored, tx.Commit(ctx) // place gone since; nothing to learn from
		}
		return "", err
	}

	place, err := taxonomy.ParseVector(placeText)
	if err != nil {
		return "", err
	}
	var old []float32
	if oldText != nil {
		if old, err = taxonomy.ParseVector(*oldText); err != nil {
			return "", err
		}
	}
	updated := taste.Update(old, place, evt.Action)
	if updated == nil {
		return ignored, tx.Commit(ctx)
	}

	// Bumping updated_at changes the taste version in the API's deck cache key, so
	// the next /quests/today ranks with the new taste without deleting any keys.
	if _, err := tx.Exec(ctx, `
		INSERT INTO taste_profiles (user_id, vec, source, updated_at) VALUES ($1, $2::vector, 'events', now())
		ON CONFLICT (user_id) DO UPDATE SET vec = EXCLUDED.vec, source = 'events', updated_at = now()`,
		evt.UserId, taxonomy.VectorLiteral(updated)); err != nil {
		return "", err
	}
	return applied, tx.Commit(ctx)
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
