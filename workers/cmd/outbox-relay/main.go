// outbox-relay publishes rows from the Postgres outbox table to Kafka.
//
// Delivery is at-least-once: a row is marked sent only after Kafka acknowledges it,
// so a crash in between re-publishes it, and consumers dedupe on event_id.
//
// Run ONE replica. FOR UPDATE SKIP LOCKED would make several replicas safe from
// double-claiming rows, but two relays could then publish one user's consecutive
// events in parallel and reorder them. A single relay keeps per-user order.
package main

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"

	"github.com/MatthewJiang168977/larper/workers/internal/platform"
)

const (
	batchSize     = 200
	idlePoll      = 250 * time.Millisecond
	retention     = "7 days"
	cleanupPeriod = 10 * time.Minute
)

func main() {
	log := platform.Logger("outbox-relay")
	ctx, stop := platform.SignalContext()
	defer stop()

	pool, err := platform.Postgres(ctx)
	if err != nil {
		platform.Fatal(log, "postgres", err)
	}
	defer pool.Close()

	// Idempotent producer (franz-go's default, acks=all): broker-side dedupe of
	// retried sends, and per-partition order preserved across retries. No topic
	// auto-creation: the Helm topics Job creates user.events with 6 partitions, and a
	// missing topic should fail loudly rather than appear with broker defaults.
	kafka, err := platform.Kafka()
	if err != nil {
		platform.Fatal(log, "kafka", err)
	}
	defer kafka.Close()

	log.Info("relaying", "batch", batchSize)
	lastCleanup := time.Now()
	for ctx.Err() == nil {
		n, err := relayBatch(ctx, pool, kafka)
		switch {
		case errors.Is(err, context.Canceled):
		case err != nil:
			log.Error("relay batch failed; will retry", "err", err)
			sleep(ctx, 2*time.Second)
		case n > 0:
			log.Info("published", "events", n)
		default:
			sleep(ctx, idlePoll)
		}
		if time.Since(lastCleanup) > cleanupPeriod {
			lastCleanup = time.Now()
			if tag, err := pool.Exec(ctx, `DELETE FROM outbox WHERE sent_at < now() - $1::interval`, retention); err == nil && tag.RowsAffected() > 0 {
				log.Info("pruned sent outbox rows", "rows", tag.RowsAffected())
			}
		}
	}
	log.Info("stopped")
}

// relayBatch claims the oldest unsent rows, publishes them, and marks them sent, all
// inside one transaction: if publishing fails, the rollback leaves them unsent.
func relayBatch(ctx context.Context, pool *pgxpool.Pool, kafka *kgo.Client) (int, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `
		SELECT id, topic, key, type, payload FROM outbox
		WHERE sent_at IS NULL ORDER BY id LIMIT $1
		FOR UPDATE SKIP LOCKED`, batchSize)
	if err != nil {
		return 0, err
	}
	var ids []int64
	var records []*kgo.Record
	for rows.Next() {
		var id int64
		var topic, key, typ string
		var payload []byte
		if err := rows.Scan(&id, &topic, &key, &typ, &payload); err != nil {
			return 0, err
		}
		ids = append(ids, id)
		records = append(records, &kgo.Record{
			Topic:   topic,
			Key:     []byte(key),
			Value:   payload,
			Headers: []kgo.RecordHeader{{Key: "type", Value: []byte(typ)}},
		})
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(records) == 0 {
		return 0, nil
	}

	// Waits for every ack; records keep their order within each partition.
	if err := kafka.ProduceSync(ctx, records...).FirstErr(); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `UPDATE outbox SET sent_at = now() WHERE id = ANY($1)`, ids); err != nil {
		return 0, err
	}
	return len(ids), tx.Commit(ctx)
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
