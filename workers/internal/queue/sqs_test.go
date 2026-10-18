package queue

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

// SQS tests also need an SQS-compatible endpoint, e.g. ElasticMQ:
//
//	docker run -d -p 9324:9324 softwaremill/elasticmq-native
//	TEST_DATABASE_URL=postgres://... TEST_SQS_ENDPOINT=http://localhost:9324 go test ./internal/queue/
//
// Each test creates its own SQS queue pair and ledger queue name.
func testSQS(t *testing.T) (*SQS, string) {
	t.Helper()
	pg, _ := testQueue(t)
	ep := os.Getenv("TEST_SQS_ENDPOINT")
	if ep == "" {
		t.Skip("TEST_SQS_ENDPOINT not set")
	}
	// SQS caps queue names at 80 chars, so not the test-name-based ledger queue.
	name := fmt.Sprintf("q%d", time.Now().UnixNano())
	t.Cleanup(func() { ownerPool.Exec(context.Background(), `DELETE FROM jobs WHERE queue = $1`, name) })
	client := sqs.New(sqs.Options{
		Region:       "us-east-1",
		BaseEndpoint: &ep,
		Credentials:  credentials.NewStaticCredentialsProvider("x", "x", ""),
	})
	prefix := "larper-test-"
	ctx := context.Background()
	for _, n := range []string{name, name + "-dlq"} {
		out, err := client.CreateQueue(ctx, &sqs.CreateQueueInput{QueueName: aws.String(prefix + n)})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { client.DeleteQueue(ctx, &sqs.DeleteQueueInput{QueueUrl: out.QueueUrl}) })
	}
	return &SQS{Pool: pg.Pool, Client: client, Prefix: prefix, Wait: time.Second}, name
}

func dispatchAll(t *testing.T, q *SQS, queue string) {
	t.Helper()
	if _, err := q.Dispatch(context.Background(), queue); err != nil {
		t.Fatal(err)
	}
}

func ledger(t *testing.T, q *SQS, id int64) (status string, attempts int) {
	t.Helper()
	if err := q.Pool.QueryRow(context.Background(), `SELECT status, attempts FROM jobs WHERE id = $1`, id).Scan(&status, &attempts); err != nil {
		t.Fatal(err)
	}
	return
}

func claim(t *testing.T, q *SQS, queue string, lease time.Duration) *Job {
	t.Helper()
	j, err := q.Claim(context.Background(), queue, lease)
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func TestSQSCompleteRoundTrip(t *testing.T) {
	q, name := testSQS(t)
	ctx := context.Background()
	enqueue(t, name, "a", 5)
	dispatchAll(t, q, name)
	if n, _ := q.Dispatch(ctx, name); n != 0 {
		t.Fatalf("second dispatch sent %d jobs, want 0", n)
	}

	j := claim(t, q, name, 30*time.Second)
	if j == nil || j.Attempt != 1 || string(j.Payload) != "{}" {
		t.Fatalf("claim = %+v", j)
	}
	if err := q.Complete(ctx, j); err != nil {
		t.Fatal(err)
	}
	if s, _ := ledger(t, q, j.ID); s != "done" {
		t.Fatalf("status %s, want done", s)
	}
	if j := claim(t, q, name, 30*time.Second); j != nil {
		t.Fatalf("queue not empty after complete: %+v", j)
	}
}

func TestSQSRetryAfterBackoff(t *testing.T) {
	q, name := testSQS(t)
	ctx := context.Background()
	enqueue(t, name, "a", 5)
	dispatchAll(t, q, name)

	j := claim(t, q, name, 30*time.Second)
	if err := q.Fail(ctx, j, errors.New("blip"), false); err != nil {
		t.Fatal(err)
	}
	if s, _ := ledger(t, q, j.ID); s != "queued" {
		t.Fatalf("status %s, want queued", s)
	}
	if again := claim(t, q, name, 30*time.Second); again != nil {
		t.Fatal("redelivered before the backoff elapsed")
	}
	time.Sleep(Backoff(1))
	again := claim(t, q, name, 30*time.Second)
	if again == nil || again.ID != j.ID || again.Attempt != 2 {
		t.Fatalf("retry = %+v, want job %d attempt 2", again, j.ID)
	}
}

func TestSQSPermanentFailureDeadLetters(t *testing.T) {
	q, name := testSQS(t)
	ctx := context.Background()
	enqueue(t, name, "a", 5)
	dispatchAll(t, q, name)

	j := claim(t, q, name, 30*time.Second)
	if err := q.Fail(ctx, j, errors.New("bad payload"), true); err != nil {
		t.Fatal(err)
	}
	if s, _ := ledger(t, q, j.ID); s != "dead" {
		t.Fatalf("status %s, want dead", s)
	}
	dlq, _ := q.url(ctx, name+"-dlq")
	out, err := q.Client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
		QueueUrl: &dlq, WaitTimeSeconds: 1, MessageAttributeNames: []string{"All"},
	})
	if err != nil || len(out.Messages) != 1 {
		t.Fatalf("dlq receive: %v, %d messages", err, len(out.Messages))
	}
	if r := aws.ToString(out.Messages[0].MessageAttributes["reason"].StringValue); r != "bad payload" {
		t.Fatalf("dlq reason %q", r)
	}
}

func TestSQSLapsedLeaseFencesOldWorker(t *testing.T) {
	q, name := testSQS(t)
	ctx := context.Background()
	enqueue(t, name, "a", 5)
	dispatchAll(t, q, name)

	first := claim(t, q, name, time.Second)
	time.Sleep(1500 * time.Millisecond) // lease lapses without a renew
	second := claim(t, q, name, 30*time.Second)
	if second == nil || second.Attempt != 2 {
		t.Fatalf("reclaim = %+v, want attempt 2", second)
	}
	if err := q.Complete(ctx, first); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale complete err = %v, want ErrLeaseLost", err)
	}
	if err := q.Complete(ctx, second); err != nil {
		t.Fatal(err)
	}
}

func TestSQSDuplicateSendIsDropped(t *testing.T) {
	q, name := testSQS(t)
	ctx := context.Background()
	enqueue(t, name, "a", 5)
	dispatchAll(t, q, name)
	// Simulate the dispatcher crashing after a send but before its commit.
	var id int64
	q.Pool.QueryRow(ctx, `SELECT id FROM jobs WHERE queue = $1`, name).Scan(&id)
	url, _ := q.url(ctx, name)
	if _, err := q.Client.SendMessage(ctx, &sqs.SendMessageInput{QueueUrl: &url, MessageBody: aws.String(fmt.Sprintf(`{"id":%d}`, id))}); err != nil {
		t.Fatal(err)
	}

	j := claim(t, q, name, 30*time.Second)
	if err := q.Complete(ctx, j); err != nil {
		t.Fatal(err)
	}
	if dup := claim(t, q, name, 30*time.Second); dup != nil {
		t.Fatalf("duplicate delivered: %+v", dup)
	}
	attrs, _ := q.Client.GetQueueAttributes(ctx, &sqs.GetQueueAttributesInput{
		QueueUrl: &url, AttributeNames: []types.QueueAttributeName{types.QueueAttributeNameApproximateNumberOfMessages},
	})
	if n := attrs.Attributes[string(types.QueueAttributeNameApproximateNumberOfMessages)]; n != "0" {
		t.Fatalf("%s messages left, want 0", n)
	}
}
