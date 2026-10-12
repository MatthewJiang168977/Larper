// Package queue is a work queue with Azure Service Bus semantics (peek-lock
// leases, delivery count, dead-lettering), backed by the Postgres jobs table.
// Workers depend on the Queue interface, so a Service Bus implementation can
// replace Postgres in the cloud without touching them.
package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrLeaseLost means the job was reclaimed by another worker (our lease lapsed),
// so this worker must not report an outcome for it.
var ErrLeaseLost = errors.New("queue: lease lost")

type Job struct {
	ID          int64
	Queue       string
	Payload     json.RawMessage
	Attempt     int // 1 on first delivery; also the fencing token for Complete/Fail
	MaxAttempts int
}

type Queue interface {
	// Claim leases the next ready job, or returns nil if there is none.
	Claim(ctx context.Context, queue string, lease time.Duration) (*Job, error)
	// Renew extends a lease for a job still in progress (Service Bus RenewLock).
	Renew(ctx context.Context, j *Job, lease time.Duration) error
	Complete(ctx context.Context, j *Job) error
	// Fail schedules a retry with backoff, or dead-letters the job when it's out of
	// attempts or the failure is permanent (retrying can't help).
	Fail(ctx context.Context, j *Job, cause error, permanent bool) error
}

// Backoff before retry n (1-based): 5s, 10s, 20s, ... capped at 5 minutes.
func Backoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	d := 5 * time.Second << min(attempt-1, 10)
	return min(d, 5*time.Minute)
}

type Postgres struct{ Pool *pgxpool.Pool }

var _ Queue = Postgres{}

// Claim takes the oldest ready job: queued and past its backoff, or running with a
// lapsed lease (its worker died). SKIP LOCKED lets many workers claim concurrently
// without blocking on, or double-claiming, the same row.
func (q Postgres) Claim(ctx context.Context, queue string, lease time.Duration) (*Job, error) {
	j := &Job{Queue: queue}
	err := q.Pool.QueryRow(ctx, `
		UPDATE jobs SET status = 'running', attempts = attempts + 1,
		       locked_until = now() + $2::interval, updated_at = now()
		WHERE id = (
		  SELECT id FROM jobs
		  WHERE queue = $1 AND (
		        (status = 'queued' AND run_after <= now())
		     OR (status = 'running' AND locked_until < now()))
		  ORDER BY run_after, id
		  FOR UPDATE SKIP LOCKED
		  LIMIT 1)
		RETURNING id, payload, attempts, max_attempts`,
		queue, lease.String()).Scan(&j.ID, &j.Payload, &j.Attempt, &j.MaxAttempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	// A job whose lease lapsed on its last allowed delivery (e.g. it crashes the
	// worker every time) is dead-lettered here instead of looping forever.
	if j.Attempt > j.MaxAttempts {
		_ = q.Fail(ctx, j, errors.New("lease expired on every delivery"), true)
		return q.Claim(ctx, queue, lease)
	}
	return j, nil
}

// Every outcome is fenced on the attempt number: if our lease lapsed and another
// worker re-claimed the job, attempts moved on and our late write matches nothing.
func (q Postgres) Renew(ctx context.Context, j *Job, lease time.Duration) error {
	return q.fenced(ctx, j, `
		UPDATE jobs SET locked_until = now() + $3::interval, updated_at = now()
		WHERE id = $1 AND attempts = $2 AND status = 'running'`, lease.String())
}

func (q Postgres) Complete(ctx context.Context, j *Job) error {
	return q.fenced(ctx, j, `
		UPDATE jobs SET status = 'done', locked_until = NULL, last_error = NULL, updated_at = now()
		WHERE id = $1 AND attempts = $2 AND status = 'running'`)
}

func (q Postgres) Fail(ctx context.Context, j *Job, cause error, permanent bool) error {
	if permanent || j.Attempt >= j.MaxAttempts {
		return q.fenced(ctx, j, `
			UPDATE jobs SET status = 'dead', locked_until = NULL, last_error = $3, updated_at = now()
			WHERE id = $1 AND attempts = $2 AND status = 'running'`, cause.Error())
	}
	return q.fenced(ctx, j, `
		UPDATE jobs SET status = 'queued', locked_until = NULL, last_error = $3,
		       run_after = now() + $4::interval, updated_at = now()
		WHERE id = $1 AND attempts = $2 AND status = 'running'`, cause.Error(), Backoff(j.Attempt).String())
}

func (q Postgres) fenced(ctx context.Context, j *Job, sql string, args ...any) error {
	tag, err := q.Pool.Exec(ctx, sql, append([]any{j.ID, j.Attempt}, args...)...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: job %d attempt %d", ErrLeaseLost, j.ID, j.Attempt)
	}
	return nil
}
