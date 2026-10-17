// Package platform holds the boring wiring every worker shares: config from env,
// Postgres, Kafka and SQS clients, and signal-aware shutdown.
package platform

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"
)

const UserEventsTopic = "user.events"

// Context cancelled on SIGTERM/SIGINT, so Kubernetes rollouts stop workers cleanly.
func SignalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
}

func Logger(service string) *slog.Logger {
	l := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", service)
	slog.SetDefault(l)
	return l
}

// Fatal logs and exits non-zero, so a misconfigured worker shows up as a crash
// (CrashLoopBackOff) instead of a clean exit.
func Fatal(log *slog.Logger, msg string, err error) {
	log.Error(msg, "err", err)
	os.Exit(1)
}

func Env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func EnvInt(key string, def int) int {
	if n, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return n
	}
	return def
}

func Postgres(ctx context.Context) (*pgxpool.Pool, error) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		return nil, fmt.Errorf("DATABASE_URL is not set")
	}
	return pgxpool.New(ctx, url)
}

// Kafka builds a franz-go client against KAFKA_BROKERS plus any extra options.
func Kafka(opts ...kgo.Opt) (*kgo.Client, error) {
	brokers := strings.Split(Env("KAFKA_BROKERS", "localhost:9092"), ",")
	return kgo.NewClient(append([]kgo.Opt{kgo.SeedBrokers(brokers...)}, opts...)...)
}

// Header returns a record header's value ("" if absent).
func Header(r *kgo.Record, key string) string {
	for _, h := range r.Headers {
		if h.Key == key {
			return string(h.Value)
		}
	}
	return ""
}

// SQS builds an SQS client from the standard AWS environment (AWS_REGION,
// AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY). SQS_ENDPOINT points it at a local
// SQS-compatible server (ElasticMQ) for development and tests.
func SQS(ctx context.Context) (*sqs.Client, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, err
	}
	return sqs.NewFromConfig(cfg, func(o *sqs.Options) {
		if ep := os.Getenv("SQS_ENDPOINT"); ep != "" {
			o.BaseEndpoint = &ep
		}
	}), nil
}
