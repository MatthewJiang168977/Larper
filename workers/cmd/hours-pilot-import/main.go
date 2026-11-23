// hours-pilot-import loads the owner's hand-verified opening hours (the filled-in CSV from
// scripts/hours-pilot-candidates) into place_hours_facts. Full instructions: docs/plans/hours-pilot.md.
//
//	cd workers
//	DATABASE_URL=postgres://... go run ./cmd/hours-pilot-import -in ../pilot/hours-candidates-2026-11-18.csv          # dry run
//	DATABASE_URL=postgres://... go run ./cmd/hours-pilot-import -in ../pilot/hours-candidates-2026-11-18.csv -apply   # writes
//
// Every row becomes kind='schedule', service='regular', source='manual', confidence 0.9,
// raw = the text as typed, schedule = the normalized v1 jsonb the API reads, source_url = the
// URL given as the source (NULL for "seen on the door"), fetched_at = date_checked. A second
// run updates the same row (unique index place_id, service, source where kind='schedule').
// One bad row rejects the whole file; all problems are printed with their line numbers.
// The dry run (the default) only reads: it never starts a write.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
)

func main() {
	in := flag.String("in", "", "the filled-in CSV")
	apply := flag.Bool("apply", false, "write to the database (default: a dry run that writes nothing)")
	flag.Parse()
	if *in == "" || os.Getenv("DATABASE_URL") == "" {
		fmt.Fprintln(os.Stderr, "usage: DATABASE_URL=... hours-pilot-import -in file.csv [-apply]")
		os.Exit(2)
	}
	os.Exit(run(*in, *apply))
}

func run(path string, apply bool) int {
	f, err := os.Open(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer f.Close()
	rows, probs := ParseCSV(f)
	if len(probs) > 0 {
		report(probs)
		return 1
	}
	if len(rows) == 0 {
		fmt.Println("no filled-in rows: nothing to do")
		return 0
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	conn, err := pgx.Connect(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "connect:", err)
		return 1
	}
	defer conn.Close(ctx)
	st := &pgStore{conn: conn}
	acts, probs, err := Plan(ctx, st, rows)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if len(probs) > 0 {
		report(probs)
		return 1
	}
	printPlan(os.Stdout, acts)
	if !apply {
		fmt.Printf("dry run: nothing written. Re-run with -apply to write these %d rows.\n", len(acts))
		return 0
	}
	if err := st.Upsert(ctx, rows); err != nil {
		fmt.Fprintln(os.Stderr, "write failed, nothing was written:", err)
		return 1
	}
	fmt.Printf("applied: %d rows written\n", len(acts))
	return 0
}

func report(probs []Problem) {
	fmt.Fprintf(os.Stderr, "rejected: %d problem(s), nothing written\n", len(probs))
	for _, p := range probs {
		fmt.Fprintln(os.Stderr, "  "+p.String())
	}
}

func printPlan(w io.Writer, acts []Action) {
	ins, upd := 0, 0
	for _, a := range acts {
		verb := "insert"
		if a.Update {
			verb = "update"
			upd++
		} else {
			ins++
		}
		src := "(seen on the door)"
		if a.Row.SourceURL != nil {
			src = *a.Row.SourceURL
		}
		fmt.Fprintf(w, "line %d: %s place %d %q  checked %s  %q  %s\n", a.Row.Line, verb, a.Row.PlaceID, a.Name, a.Row.CheckedAt.Format("2006-01-02"), a.Row.Hours, src)
	}
	fmt.Fprintf(w, "%d insert, %d update\n", ins, upd)
}

type pgStore struct{ conn *pgx.Conn }

func (s *pgStore) PlaceNames(ctx context.Context, ids []int64) (map[int64]string, error) {
	rs, err := s.conn.Query(ctx, `SELECT id, coalesce(name, '') FROM places WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	out := map[int64]string{}
	for rs.Next() {
		var id int64
		var name string
		if err := rs.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rs.Err()
}

func (s *pgStore) ExistingSchedules(ctx context.Context, ids []int64) (map[int64]bool, error) {
	rs, err := s.conn.Query(ctx, `
		SELECT p.id, EXISTS (SELECT FROM place_hours_facts f
		                     WHERE f.place_id = p.id AND f.kind = 'schedule' AND f.service = 'regular' AND f.source = 'manual')
		FROM places p WHERE p.id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	out := map[int64]bool{}
	for rs.Next() {
		var id int64
		var has bool
		if err := rs.Scan(&id, &has); err != nil {
			return nil, err
		}
		out[id] = has
	}
	return out, rs.Err()
}

const upsertSQL = `
INSERT INTO place_hours_facts (place_id, kind, service, source, source_url, fetched_at, confidence, raw, schedule)
VALUES ($1, 'schedule', 'regular', 'manual', $2, $3, $4, $5, $6::jsonb)
ON CONFLICT (place_id, service, source) WHERE kind = 'schedule'
DO UPDATE SET source_url = EXCLUDED.source_url, fetched_at = EXCLUDED.fetched_at,
              confidence = EXCLUDED.confidence, raw = EXCLUDED.raw, schedule = EXCLUDED.schedule`

func (s *pgStore) Upsert(ctx context.Context, rows []Row) error {
	tx, err := s.conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // a no-op after Commit
	for _, r := range rows {
		if _, err := tx.Exec(ctx, upsertSQL, r.PlaceID, r.SourceURL, r.CheckedAt, Confidence, r.Raw(), string(r.Schedule)); err != nil {
			return fmt.Errorf("line %d: %w", r.Line, err)
		}
	}
	return tx.Commit(ctx)
}
