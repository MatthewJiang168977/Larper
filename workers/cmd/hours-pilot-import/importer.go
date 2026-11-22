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
	CSVName   string          // the name column as exported, if the file has one; checked against the database
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

// parseCheckedDate reads the date the hours were checked: YYYY-MM-DD as the template asks,
// or M/D/YYYY, which US-locale Excel turns a typed date into when it saves the CSV. Day-first
// dates (18/11/2026) fail here rather than being read the wrong way round.
func parseCheckedDate(s string) (time.Time, error) {
	d, err := time.ParseInLocation("2006-01-02", s, nyc)
	if err == nil {
		return d, nil
	}
	if d, uerr := time.ParseInLocation("1/2/2006", s, nyc); uerr == nil {
		return d, nil
	}
	return time.Time{}, err
}

// ParseCSV reads the owner's filled-in file. A row whose opening_hours, source and date_checked
// are all empty is skipped (a candidate the owner did not get to). Every other row is checked;
// the caller must write nothing if any Problem comes back.
func ParseCSV(r io.Reader) ([]Row, []Problem) {
	return parseCSVAt(r, time.Now())
}

func parseCSVAt(r io.Reader, now time.Time) ([]Row, []Problem) {
	year, month, day := now.In(nyc).Date()
	today := time.Date(year, month, day, 0, 0, 0, 0, nyc)

	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1 // checked per row below, with its line
	head, err := cr.Read()
	if err != nil {
		return nil, []Problem{{1, "cannot read the header: " + err.Error()}}
	}
	col := map[string]int{}
	for i, h := range head {
		if i == 0 {
			h = strings.TrimPrefix(h, "\uFEFF") // Excel's "CSV UTF-8" starts the file with a BOM
		}
		col[strings.ToLower(strings.TrimSpace(h))] = i
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
		} else if d, derr := parseCheckedDate(dc); derr != nil {
			add(fmt.Sprintf("date_checked %q is not YYYY-MM-DD (or M/D/YYYY, as US Excel saves it)", dc))
		} else if d.After(today) {
			add(fmt.Sprintf("date_checked %s is in the future", dc))
		} else {
			// Store the checked date at noon New York time.
			checked = time.Date(d.Year(), d.Month(), d.Day(), 12, 0, 0, 0, nyc)
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
			// The exporter prefixes a name that could run as a spreadsheet formula with '.
			name := strings.TrimPrefix(get(rec, "name"), "'")
			rows = append(rows, Row{Line: line, PlaceID: id, Hours: oh, SourceURL: srcURL, CheckedAt: checked, Schedule: raw, CSVName: name})
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
	// PlaceNames returns the database name of each of the given places that exists.
	PlaceNames(ctx context.Context, placeIDs []int64) (map[int64]string, error)
	// Upsert writes all rows in one transaction: every row lands or none does.
	Upsert(ctx context.Context, rows []Row) error
}

// Action is what applying a row does.
type Action struct {
	Row    Row
	Update bool   // false: insert
	Name   string // the place's name in the database, printed in the dry run
}

// sameName compares names the way a person would: case, spacing and curly quotes aside.
func sameName(a, b string) bool {
	norm := func(s string) string {
		s = strings.NewReplacer("’", "'", "‘", "'", "“", `"`, "”", `"`).Replace(s)
		return strings.Join(strings.Fields(strings.ToLower(s)), " ")
	}
	return norm(a) == norm(b)
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
	names, err := st.PlaceNames(ctx, ids)
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
		// A mistyped place_id that happens to exist would put verified hours on the wrong
		// venue: when the file still has the exported name, it must match.
		if r.CSVName != "" && !sameName(r.CSVName, names[r.PlaceID]) {
			probs = append(probs, Problem{r.Line, fmt.Sprintf("place %d is %q in the database, but this row says %q: check the place_id", r.PlaceID, names[r.PlaceID], r.CSVName)})
			continue
		}
		acts = append(acts, Action{Row: r, Update: upd, Name: names[r.PlaceID]})
	}
	if len(probs) > 0 {
		return nil, probs, nil
	}
	return acts, nil, nil
}
