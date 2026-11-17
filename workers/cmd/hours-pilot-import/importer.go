package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"

	_ "time/tzdata" // the zone database, so America/New_York works on any machine

	"github.com/MatthewJiang168977/larper/workers/internal/hours"
)

// Confidence stored for a hand-verified schedule. The owner looked at the door or the venue's own
// page, so it is the highest confidence any importer writes (a source read by a program would be
// lower). Below 1.0 only because a person can mis-transcribe.
const Confidence = 0.9

const doorText = "seen on the door"

// Row is one validated CSV row, ready to write.
type Row struct {
	Line      int // 1-based line in the file
	PlaceID   int64
	Hours     string  // the original opening_hours text
	SourceURL *string // nil for "seen on the door"
	CheckedAt time.Time
	Schedule  json.RawMessage // the normalized v1 schedule, as hours.Schedule marshals it
}

// Raw is what goes in the raw column: the text as typed. For "seen on the door" a second line
// says so, because source_url is NULL then; the first line is always exactly the typed hours.
func (r Row) Raw() string {
	if r.SourceURL == nil {
		return r.Hours + "\n[" + doorText + "]"
	}
	return r.Hours
}

// Problem is one thing wrong with the file, with its line.
type Problem struct {
	Line int
	Msg  string
}

func (p Problem) String() string { return fmt.Sprintf("line %d: %s", p.Line, p.Msg) }

var nyc = func() *time.Location {
	l, err := time.LoadLocation("America/New_York")
	if err != nil {
		panic(err)
	}
	return l
}()

// ParseCSV reads the owner's filled-in file. A row whose opening_hours, source and date_checked
// are all empty is skipped (a candidate the owner did not get to). Every other row is checked;
// the caller must write nothing if any Problem comes back.
func ParseCSV(r io.Reader) ([]Row, []Problem) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1 // checked per row below, with its line
	head, err := cr.Read()
	if err != nil {
		return nil, []Problem{{1, "cannot read the header: " + err.Error()}}
	}
	col := map[string]int{}
	for i, h := range head {
		h = strings.TrimSpace(strings.TrimPrefix(h, "ï»¿")) // Excel adds a BOM
		col[strings.ToLower(h)] = i
	}
	var probs []Problem
	for _, need := range []string{"place_id", "opening_hours", "source", "date_checked"} {
		if _, ok := col[need]; !ok {
			probs = append(probs, Problem{1, "missing column " + need})
		}
	}
	if len(probs) > 0 {
		return nil, probs
	}
	get := func(rec []string, name string) string {
		if i := col[name]; i < len(rec) {
			return strings.TrimSpace(rec[i])
		}
		return ""
	}

	var rows []Row
	seen := map[int64]int{}
	for {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			var pe *csv.ParseError
			if errors.As(err, &pe) {
				probs = append(probs, Problem{pe.StartLine, "unreadable row: " + err.Error()})
				continue
			}
			probs = append(probs, Problem{0, "unreadable file: " + err.Error()})
			break
		}
		line, _ := cr.FieldPos(0)
		oh, src, dc := get(rec, "opening_hours"), get(rec, "source"), get(rec, "date_checked")
		if oh == "" && src == "" && dc == "" {
			continue // not filled in
		}
		n0 := len(probs)
		add := func(m string) { probs = append(probs, Problem{line, m}) }

		idText := get(rec, "place_id")
		id, perr := strconv.ParseInt(idText, 10, 64)
		if perr != nil || id <= 0 {
			add(fmt.Sprintf("place_id %q is not a positive integer", idText))
		} else if first, dup := seen[id]; dup {
			add(fmt.Sprintf("place_id %d appears twice (first on line %d)", id, first))
		} else {
			seen[id] = line
		}

		var srcURL *string
		switch {
		case src == "":
			add(`source is empty: use the website URL or "seen on the door"`)
		case strings.EqualFold(src, doorText):
		default:
			u, uerr := url.Parse(src)
			if uerr != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
				add(fmt.Sprintf(`source %q must be an http(s) URL or "seen on the door"`, src))
			} else {
				s := src
				srcURL = &s
			}
		}

		var checked time.Time
		if dc == "" {
			add("date_checked is empty (YYYY-MM-DD)")
		} else if d, derr := time.ParseInLocation("2006-01-02", dc, nyc); derr != nil {
			add(fmt.Sprintf("date_checked %q is not YYYY-MM-DD", dc))
		} else {
			// Noon New York time on that day: the date stays right in any zone it is shown in.
			checked = time.Date(d.Year(), d.Month(), d.Day(), 12, 0, 0, 0, nyc)
			if checked.After(time.Now().Add(24 * time.Hour)) {
				add(fmt.Sprintf("date_checked %s is in the future", dc))
			}
		}

		var raw json.RawMessage
		if oh == "" {
			add("opening_hours is empty")
		} else {
			sched, warns, perr := hours.ParseOSM(oh)
			switch {
			case perr != nil:
				add(fmt.Sprintf("opening_hours %q: %v", oh, perr))
			case sched.Partial != hours.PartialNone:
				ws := make([]string, len(warns))
				for i, w := range warns {
					ws[i] = w.String()
				}
				add(fmt.Sprintf("opening_hours %q is only partly understood (%s): %s; simplify it", oh, sched.Partial, strings.Join(ws, "; ")))
			default:
				if verr := sched.Validate(); verr != nil {
					add(fmt.Sprintf("opening_hours %q: %v", oh, verr))
				} else if b, merr := json.Marshal(sched); merr != nil {
					add(fmt.Sprintf("opening_hours %q: %v", oh, merr))
				} else {
					raw = b
				}
			}
		}
		if len(probs) == n0 {
			rows = append(rows, Row{Line: line, PlaceID: id, Hours: oh, SourceURL: srcURL, CheckedAt: checked, Schedule: raw})
		}
	}
	if len(probs) > 0 {
		return nil, probs
	}
	return rows, nil
}

// Store is the database, as far as the importer needs it.
type Store interface {
	// ExistingSchedules returns, for those of the given places that exist, whether a manual
	// regular schedule is already on file (true = the write would update it). A place missing
	// from the map does not exist.
	ExistingSchedules(ctx context.Context, placeIDs []int64) (map[int64]bool, error)
	// Upsert writes all rows in one transaction: every row lands or none does.
	Upsert(ctx context.Context, rows []Row) error
}

// Action is what applying a row does.
type Action struct {
	Row    Row
	Update bool // false: insert
}

// Plan refuses places that do not exist (every one is reported) and says what each row does.
func Plan(ctx context.Context, st Store, rows []Row) ([]Action, []Problem, error) {
	ids := make([]int64, len(rows))
	for i, r := range rows {
		ids[i] = r.PlaceID
	}
	have, err := st.ExistingSchedules(ctx, ids)
	if err != nil {
		return nil, nil, err
	}
	var acts []Action
	var probs []Problem
	for _, r := range rows {
		upd, ok := have[r.PlaceID]
		if !ok {
			probs = append(probs, Problem{r.Line, fmt.Sprintf("place %d does not exist", r.PlaceID)})
			continue
		}
		acts = append(acts, Action{Row: r, Update: upd})
	}
	if len(probs) > 0 {
		return nil, probs, nil
	}
	return acts, nil, nil
}
