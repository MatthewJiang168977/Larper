// ingest-worker loads place data for areas Larper hasn't seen yet.
//
// The API enqueues an `ingest-area` job ({"geohash5": "dr5rs"}) when someone opens
// the app somewhere without data. This worker leases a job, extracts that ~5x5 km
// cell from Overture with DuckDB, tags and upserts the places, recomputes area
// stats, and completes the job. Leases are renewed while it works; if the worker
// dies, the lease lapses and another replica picks the job up.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mmcloughlin/geohash"

	"github.com/MatthewJiang168977/larper/workers/internal/places"
	"github.com/MatthewJiang168977/larper/workers/internal/platform"
	"github.com/MatthewJiang168977/larper/workers/internal/queue"
	"github.com/MatthewJiang168977/larper/workers/internal/taxonomy"
)

const queueName = "ingest-area"

var geohash5 = regexp.MustCompile(`^[0123456789bcdefghjkmnpqrstuvwxyz]{5}$`)

type payload struct {
	Geohash5 string `json:"geohash5"`
}

type config struct {
	release   string
	lease     time.Duration
	idlePoll  time.Duration
	duckMem   string
	duckCores int
	minConf   float64
	location  places.LocationCheck
}

func main() {
	log := platform.Logger(queueName + "-worker")
	ctx, stop := platform.SignalContext()
	defer stop()

	cfg := config{
		release:   platform.Env("OVERTURE_RELEASE", "2026-09-23.1"),
		lease:     time.Duration(platform.EnvInt("JOB_LEASE_SECONDS", 120)) * time.Second,
		idlePoll:  2 * time.Second,
		duckMem:   platform.Env("DUCKDB_MEMORY_LIMIT", "512MB"),
		duckCores: platform.EnvInt("DUCKDB_THREADS", 2),
		minConf:   0.5,
		// US ZIP prefixes inside the region (Helm ingest.postcodePrefixes): flags places
		// whose address contradicts their point (places/location.go).
		location: places.LocationCheck{PostcodePrefixes: places.ParsePrefixes(platform.Env("PLACE_POSTCODE_PREFIXES", ""))},
	}

	pool, err := platform.Postgres(ctx)
	if err != nil {
		platform.Fatal(log, "postgres", err)
	}
	defer pool.Close()
	tax, err := taxonomy.Default()
	if err != nil {
		platform.Fatal(log, "taxonomy", err)
	}
	// QUEUE_BACKEND=sqs in the cloud: SQS delivers, the jobs table stays the ledger.
	var q queue.Queue = queue.Postgres{Pool: pool}
	backend := platform.Env("QUEUE_BACKEND", "postgres")
	if backend == "sqs" {
		client, err := platform.SQS(ctx)
		if err != nil {
			platform.Fatal(log, "sqs", err)
		}
		sq := &queue.SQS{Pool: pool, Client: client, Prefix: platform.Env("SQS_QUEUE_PREFIX", "larper-"), Wait: 20 * time.Second}
		q = sq
		// Every replica dispatches; SKIP LOCKED keeps them off each other's rows.
		go dispatch(ctx, log, sq)
		cfg.idlePoll = 0 // Claim already long-polls
	}

	log.Info("waiting for jobs", "queue", queueName, "backend", backend, "release", cfg.release, "lease", cfg.lease.String())
	for ctx.Err() == nil {
		job, err := q.Claim(ctx, queueName, cfg.lease)
		if err != nil {
			if ctx.Err() == nil {
				log.Error("claim", "err", err)
				sleep(ctx, 5*time.Second)
			}
			continue
		}
		if job == nil {
			sleep(ctx, cfg.idlePoll)
			continue
		}
		runJob(ctx, log, q, job, cfg, func(jctx context.Context, p payload) (places.Result, error) {
			return ingest(jctx, pool, tax, p.Geohash5, cfg)
		})
	}
	log.Info("stopped")
}

// dispatch moves new jobs from the ledger into SQS (the outbox step).
func dispatch(ctx context.Context, log *slog.Logger, q *queue.SQS) {
	for ctx.Err() == nil {
		n, err := q.Dispatch(ctx, queueName)
		switch {
		case ctx.Err() != nil:
		case err != nil:
			log.Error("dispatch", "err", err)
			sleep(ctx, 5*time.Second)
		case n > 0:
			log.Info("dispatched", "jobs", n)
		default:
			sleep(ctx, time.Second)
		}
	}
}

func runJob(ctx context.Context, log *slog.Logger, q queue.Queue, job *queue.Job, cfg config,
	work func(context.Context, payload) (places.Result, error)) {
	log = log.With("job", job.ID, "attempt", job.Attempt)

	var p payload
	if err := json.Unmarshal(job.Payload, &p); err != nil || !geohash5.MatchString(p.Geohash5) {
		log.Warn("bad payload; dead-lettering", "payload", string(job.Payload))
		report(log, q.Fail(ctx, job, fmt.Errorf("bad payload %s", job.Payload), true))
		return
	}
	log = log.With("geohash5", p.Geohash5)
	log.Info("ingesting")

	// Renew the lease in the background, like Service Bus RenewLock. If renewal
	// shows we lost the lease, cancel the work: someone else owns the job now.
	jctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		t := time.NewTicker(cfg.lease / 3)
		defer t.Stop()
		for {
			select {
			case <-jctx.Done():
				return
			case <-t.C:
				if err := q.Renew(jctx, job, cfg.lease); errors.Is(err, queue.ErrLeaseLost) {
					log.Warn("lease lost; abandoning job")
					cancel()
					return
				}
			}
		}
	}()

	start := time.Now()
	res, err := work(jctx, p)
	cancel()
	switch {
	case ctx.Err() != nil:
		// Shutting down: don't report. The lease lapses and another replica retries.
		log.Info("interrupted; job will be redelivered")
	case err != nil:
		// Network blips, S3 throttling, a DB restart: all worth retrying with backoff.
		log.Error("ingest failed", "err", err, "retry_in", queue.Backoff(job.Attempt), "max_attempts", job.MaxAttempts)
		report(log, q.Fail(ctx, job, err, false))
	default:
		log.Info("ingested", "read", res.Read, "kept", res.Kept, "areas", len(res.Areas),
			"elapsed", time.Since(start).Round(time.Millisecond).String())
		report(log, q.Complete(ctx, job))
	}
}

func report(log *slog.Logger, err error) {
	if errors.Is(err, queue.ErrLeaseLost) {
		log.Warn("lease lost before reporting; another worker owns the job")
	} else if err != nil {
		log.Error("report outcome", "err", err)
	}
}

func ingest(ctx context.Context, pool *pgxpool.Pool, tax *taxonomy.Taxonomy, gh string, cfg config) (places.Result, error) {
	b := geohash.BoundingBox(gh)
	dir, err := os.MkdirTemp("", "ingest-"+gh)
	if err != nil {
		return places.Result{}, err
	}
	defer os.RemoveAll(dir)
	out := filepath.Join(dir, "area.parquet")

	box := places.Box{MinLng: b.MinLng, MinLat: b.MinLat, MaxLng: b.MaxLng, MaxLat: b.MaxLat}
	if err := places.Extract(ctx, box, cfg.release, out, cfg.duckMem, cfg.duckCores); err != nil {
		return places.Result{}, err
	}
	// Mark exactly the requested cell: even a cell of river with no quest-worthy places
	// has been surveyed, and the API must stop asking for it.
	return places.Load(ctx, pool, tax, places.Options{
		Path: out, Release: cfg.release, MinConf: cfg.minConf, MarkOnly: []string{gh}, Location: cfg.location,
	})
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
