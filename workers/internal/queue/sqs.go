package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SQS delivers jobs through Amazon SQS, with the jobs table as the ledger.
//
// Split of responsibilities:
//
//	jobs table  dedupe (one live job per key), status, attempts, last error. The API
//	            only ever inserts rows; it never talks to SQS.
//	Dispatch    the outbox step: sends undispatched rows to SQS and stamps them.
//	SQS         delivery. The visibility timeout is the lease, ChangeMessageVisibility
//	            renews it (and schedules backoff retries), ApproximateReceiveCount is
//	            the attempt number.
//
// Messages carry only the job id; the payload is read from the ledger. Every ledger
// write is fenced on the attempt number exactly like the Postgres queue, so a worker
// whose lease lapsed can't overwrite the outcome of the one that took over.
type SQS struct {
	Pool   *pgxpool.Pool
	Client *sqs.Client
	// Queue "ingest-area" maps to the SQS queue Prefix+"ingest-area", and its
	// dead-letter queue to Prefix+"ingest-area-dlq".
	Prefix string
	// Long-poll wait for Claim (max 20s). Long polling keeps idle workers to about
	// 130k requests a month each, well inside the SQS free tier.
	Wait time.Duration

	urls sync.Map // SQS queue name -> URL
}

var _ Queue = (*SQS)(nil)

type sqsBody struct {
	ID int64 `json:"id"`
}

// Claim long-polls SQS for one message and records the delivery in the ledger. A
// message whose ledger row is already finished or past this attempt (a duplicate
// send, or a redelivery the ledger has seen) is deleted and skipped.
func (q *SQS) Claim(ctx context.Context, queue string, lease time.Duration) (*Job, error) {
	url, err := q.url(ctx, queue)
	if err != nil {
		return nil, err
	}
	for {
		out, err := q.Client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
			QueueUrl:                    &url,
			MaxNumberOfMessages:         1,
			WaitTimeSeconds:             int32(q.Wait / time.Second),
			VisibilityTimeout:           seconds(lease),
			MessageSystemAttributeNames: []types.MessageSystemAttributeName{types.MessageSystemAttributeNameApproximateReceiveCount},
		})
		if err != nil {
			return nil, err
		}
		if len(out.Messages) == 0 {
			return nil, nil
		}
		m := out.Messages[0]
		var body sqsBody
		attempt, convErr := strconv.Atoi(m.Attributes[string(types.MessageSystemAttributeNameApproximateReceiveCount)])
		if err := json.Unmarshal([]byte(aws.ToString(m.Body)), &body); err != nil || convErr != nil || body.ID == 0 {
			// Not ours to interpret: park it in the DLQ for a human.
			if err := q.deadLetter(ctx, queue, url, m.Body, m.ReceiptHandle, "unparseable message"); err != nil {
				return nil, err
			}
			continue
		}

		j := &Job{ID: body.ID, Queue: queue, Attempt: attempt, receipt: aws.ToString(m.ReceiptHandle)}
		err = q.Pool.QueryRow(ctx, `
			UPDATE jobs SET status = 'running', attempts = $2,
			       locked_until = now() + $3::interval, updated_at = now()
			WHERE id = $1 AND status IN ('queued', 'running') AND attempts < $2
			RETURNING payload, max_attempts`,
			j.ID, j.Attempt, lease.String()).Scan(&j.Payload, &j.MaxAttempts)
		if errors.Is(err, pgx.ErrNoRows) {
			if _, err := q.Client.DeleteMessage(ctx, &sqs.DeleteMessageInput{QueueUrl: &url, ReceiptHandle: m.ReceiptHandle}); err != nil {
				return nil, err
			}
			continue
		}
		if err != nil {
			return nil, err
		}
		// Same rule as the Postgres queue: a job whose lease lapsed on its last allowed
		// delivery is dead-lettered instead of looping. The SQS redrive policy is set
		// higher, as a backstop in case this write never happens.
		if j.Attempt > j.MaxAttempts {
			_ = q.Fail(ctx, j, errors.New("lease expired on every delivery"), true)
			continue
		}
		return j, nil
	}
}

func (q *SQS) Renew(ctx context.Context, j *Job, lease time.Duration) error {
	if err := q.fenced(ctx, j, `
		UPDATE jobs SET locked_until = now() + $3::interval, updated_at = now()
		WHERE id = $1 AND attempts = $2 AND status = 'running'`, lease.String()); err != nil {
		return err
	}
	return q.setVisibility(ctx, j, lease)
}

// Complete records success first, then deletes the message. If the delete fails the
// message comes back, and Claim drops it because the ledger says done.
func (q *SQS) Complete(ctx context.Context, j *Job) error {
	if err := q.fenced(ctx, j, `
		UPDATE jobs SET status = 'done', locked_until = NULL, last_error = NULL, updated_at = now()
		WHERE id = $1 AND attempts = $2 AND status = 'running'`); err != nil {
		return err
	}
	return q.delete(ctx, j)
}

// Fail dead-letters (ledger 'dead' + a copy in the DLQ) or schedules a retry: the
// message stays in flight and its visibility timeout becomes the backoff delay.
func (q *SQS) Fail(ctx context.Context, j *Job, cause error, permanent bool) error {
	if permanent || j.Attempt >= j.MaxAttempts {
		if err := q.fenced(ctx, j, `
			UPDATE jobs SET status = 'dead', locked_until = NULL, last_error = $3, updated_at = now()
			WHERE id = $1 AND attempts = $2 AND status = 'running'`, cause.Error()); err != nil {
			return err
		}
		url, err := q.url(ctx, j.Queue)
		if err != nil {
			return err
		}
		body, _ := json.Marshal(sqsBody{ID: j.ID})
		return q.deadLetter(ctx, j.Queue, url, aws.String(string(body)), &j.receipt, cause.Error())
	}
	backoff := Backoff(j.Attempt)
	if err := q.fenced(ctx, j, `
		UPDATE jobs SET status = 'queued', locked_until = NULL, last_error = $3,
		       run_after = now() + $4::interval, updated_at = now()
		WHERE id = $1 AND attempts = $2 AND status = 'running'`, cause.Error(), backoff.String()); err != nil {
		return err
	}
	return q.setVisibility(ctx, j, backoff)
}

// Dispatch sends up to 10 undispatched jobs (one SQS batch) and stamps them, inside
// one transaction: a failed send rolls back and is retried. A crash after the send
// but before the commit sends the job twice; Claim drops the duplicate.
func (q *SQS) Dispatch(ctx context.Context, queue string) (int, error) {
	url, err := q.url(ctx, queue)
	if err != nil {
		return 0, err
	}
	tx, err := q.Pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `
		SELECT id FROM jobs
		WHERE queue = $1 AND status = 'queued' AND dispatched_at IS NULL
		ORDER BY id LIMIT 10
		FOR UPDATE SKIP LOCKED`, queue)
	if err != nil {
		return 0, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil || len(ids) == 0 {
		return 0, err
	}
	entries := make([]types.SendMessageBatchRequestEntry, len(ids))
	for i, id := range ids {
		body, _ := json.Marshal(sqsBody{ID: id})
		entries[i] = types.SendMessageBatchRequestEntry{Id: aws.String(strconv.FormatInt(id, 10)), MessageBody: aws.String(string(body))}
	}
	out, err := q.Client.SendMessageBatch(ctx, &sqs.SendMessageBatchInput{QueueUrl: &url, Entries: entries})
	if err != nil {
		return 0, err
	}
	// Partial failures stay undispatched and go out with the next batch.
	sent := make([]int64, 0, len(out.Successful))
	for _, s := range out.Successful {
		id, _ := strconv.ParseInt(aws.ToString(s.Id), 10, 64)
		sent = append(sent, id)
	}
	if _, err := tx.Exec(ctx, `UPDATE jobs SET dispatched_at = now() WHERE id = ANY($1)`, sent); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	if len(out.Failed) > 0 {
		return len(sent), fmt.Errorf("sqs: %d of %d sends failed: %s", len(out.Failed), len(ids), aws.ToString(out.Failed[0].Message))
	}
	return len(sent), nil
}

// deadLetter copies a message to the queue's DLQ (with the reason as an attribute)
// and deletes the original. SQS's own redrive only moves messages that hit the
// receive limit; permanent failures need moving by hand.
func (q *SQS) deadLetter(ctx context.Context, queue, url string, body, receipt *string, reason string) error {
	dlq, err := q.url(ctx, queue+"-dlq")
	if err != nil {
		return err
	}
	if _, err := q.Client.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl:    &dlq,
		MessageBody: body,
		MessageAttributes: map[string]types.MessageAttributeValue{
			"reason": {DataType: aws.String("String"), StringValue: aws.String(truncate(reason, 1024))},
		},
	}); err != nil {
		return err
	}
	_, err = q.Client.DeleteMessage(ctx, &sqs.DeleteMessageInput{QueueUrl: &url, ReceiptHandle: receipt})
	return err
}

func (q *SQS) setVisibility(ctx context.Context, j *Job, d time.Duration) error {
	url, err := q.url(ctx, j.Queue)
	if err != nil {
		return err
	}
	_, err = q.Client.ChangeMessageVisibility(ctx, &sqs.ChangeMessageVisibilityInput{
		QueueUrl: &url, ReceiptHandle: &j.receipt, VisibilityTimeout: seconds(d),
	})
	return err
}

func (q *SQS) delete(ctx context.Context, j *Job) error {
	url, err := q.url(ctx, j.Queue)
	if err != nil {
		return err
	}
	_, err = q.Client.DeleteMessage(ctx, &sqs.DeleteMessageInput{QueueUrl: &url, ReceiptHandle: &j.receipt})
	return err
}

func (q *SQS) fenced(ctx context.Context, j *Job, sql string, args ...any) error {
	return Postgres{Pool: q.Pool}.fenced(ctx, j, sql, args...)
}

func (q *SQS) url(ctx context.Context, queue string) (string, error) {
	name := q.Prefix + queue
	if u, ok := q.urls.Load(name); ok {
		return u.(string), nil
	}
	out, err := q.Client.GetQueueUrl(ctx, &sqs.GetQueueUrlInput{QueueName: &name})
	if err != nil {
		return "", fmt.Errorf("sqs queue %s: %w", name, err)
	}
	q.urls.Store(name, aws.ToString(out.QueueUrl))
	return aws.ToString(out.QueueUrl), nil
}

func seconds(d time.Duration) int32 { return int32(d.Round(time.Second) / time.Second) }

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
