package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const header = "place_id,neighborhood,name,address,website,phone,opening_hours,source,date_checked\r\n"

func parse(t *testing.T, body string) ([]Row, []Problem) {
	t.Helper()
	return ParseCSV(strings.NewReader(header + body))
}

func TestParseCSVValidRows(t *testing.T) {
	rows, probs := parse(t, strings.Join([]string{
		`10,East Village,"Joe, Co",,https://joe.example,,Mo-Fr 09:00-17:00,https://joe.example/hours,2026-11-18`,
		`11,Union Square,Bar,,,,"Mo-Su 17:00-02:00",seen on the door,2026-11-18`,
		"",
	}, "\r\n"))
	if len(probs) > 0 {
		t.Fatalf("problems: %v", probs)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d", len(rows))
	}
	a, b := rows[0], rows[1]
	if a.PlaceID != 10 || a.SourceURL == nil || *a.SourceURL != "https://joe.example/hours" || a.Raw() != "Mo-Fr 09:00-17:00" {
		t.Errorf("row a = %+v", a)
	}
	if a.CheckedAt.Format("2006-01-02 15:04 MST") != "2026-11-18 12:00 EST" {
		t.Errorf("fetched_at = %v", a.CheckedAt)
	}
	if b.SourceURL != nil || b.Raw() != "Mo-Su 17:00-02:00\n[seen on the door]" {
		t.Errorf("door row = %+v raw %q", b, b.Raw())
	}
	if a.Line != 2 || b.Line != 3 {
		t.Errorf("lines = %d, %d", a.Line, b.Line)
	}
	// The schedule is the normalized v1 document: every key present.
	var m map[string]json.RawMessage
	if err := json.Unmarshal(a.Schedule, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"v", "tz", "always", "weekly", "dates", "holidays", "partial"} {
		if _, ok := m[k]; !ok {
			t.Errorf("schedule lacks key %q: %s", k, a.Schedule)
		}
	}
}

func TestParseCSVBlankRowsSkipped(t *testing.T) {
	rows, probs := parse(t, "10,East Village,A,,,,,,\r\n11,East Village,B,,,,,,\r\n\r\n")
	if len(probs) > 0 || len(rows) != 0 {
		t.Fatalf("rows %v probs %v", rows, probs)
	}
}

func TestParseCSVRejectsEverythingWithLineNumbers(t *testing.T) {
	_, probs := parse(t, strings.Join([]string{
		`10,EV,A,,,,Mo-Fr 09:00-17:00,seen on the door,2026-11-18`,      // line 2: fine
		`11,EV,B,,,,Mo-Fr 9am-5pm,seen on the door,2026-11-18`,          // line 3: 12-hour times
		`12,EV,C,,,,Mo-Fr banana,seen on the door,2026-11-18`,           // line 4: nothing usable
		`13,EV,D,,,,Mo-Fr 09:00-17:00,the internet,2026-11-18`,          // line 5: bad source
		`14,EV,E,,,,Mo-Fr 09:00-17:00,seen on the door,18/11/2026`,      // line 6: bad date
		`15,EV,F,,,,Mo-Fr 09:00-17:00,seen on the door,`,                // line 7: no date
		`x,EV,G,,,,Mo-Fr 09:00-17:00,seen on the door,2026-11-18`,       // line 8: bad id
		`10,EV,H,,,,Mo-Fr 10:00-18:00,seen on the door,2026-11-18`,      // line 9: duplicate of line 2
		`16,EV,I,,,,Mo-Fr 09:00-17:00,,2026-11-18`,                      // line 10: no source
		`17,EV,J,,,,,seen on the door,2026-11-18`,                       // line 11: no hours
		`18,EV,K,,,,Mo-Fr 09:00-17:00,seen on the door,2999-01-01`,      // line 12: future
		`19,EV,L,,,,Mo-Fr 09:00-17:00; Sa 17:00+,seen on the door,2026-11-18`, // line 13: partly understood
		"",
	}, "\r\n"))
	want := map[int]string{3: "12-hour", 4: "no usable", 5: "source", 6: "date_checked", 7: "date_checked", 8: "place_id", 9: "twice", 10: "source", 11: "opening_hours", 12: "future", 13: "partly"}
	got := map[int]string{}
	for _, p := range probs {
		got[p.Line] += p.Msg + ";"
	}
	for line, frag := range want {
		if !strings.Contains(got[line], frag) {
			t.Errorf("line %d: want a problem mentioning %q, got %q", line, frag, got[line])
		}
	}
	if _, bad := got[2]; bad {
		t.Errorf("line 2 is valid but got %q", got[2])
	}
}

func TestParseCSVHeaderProblems(t *testing.T) {
	_, probs := ParseCSV(strings.NewReader("place_id,name\r\n1,x\r\n"))
	if len(probs) != 3 { // opening_hours, source, date_checked
		t.Fatalf("probs = %v", probs)
	}
}

func TestParseCSVExcelBOM(t *testing.T) {
	rows, probs := ParseCSV(strings.NewReader("ï»¿" + header + "10,EV,A,,,,Mo-Fr 09:00-17:00,seen on the door,2026-11-18\r\n"))
	if len(probs) > 0 || len(rows) != 1 {
		t.Fatalf("rows %v probs %v", rows, probs)
	}
}

type fakeStore struct {
	places  map[int64]bool // id -> has a manual schedule already
	written []Row
}

func (f *fakeStore) ExistingSchedules(_ context.Context, ids []int64) (map[int64]bool, error) {
	out := map[int64]bool{}
	for _, id := range ids {
		if has, ok := f.places[id]; ok {
			out[id] = has
		}
	}
	return out, nil
}

func (f *fakeStore) Upsert(_ context.Context, rows []Row) error {
	f.written = append(f.written, rows...)
	return nil
}

func TestPlanRefusesUnknownPlacesAndSeparatesInsertFromUpdate(t *testing.T) {
	rows, probs := parse(t, strings.Join([]string{
		`10,EV,A,,,,Mo-Fr 09:00-17:00,seen on the door,2026-11-18`,
		`11,EV,B,,,,Mo-Fr 09:00-17:00,seen on the door,2026-11-18`,
		`99,EV,C,,,,Mo-Fr 09:00-17:00,seen on the door,2026-11-18`,
		"",
	}, "\r\n"))
	if len(probs) > 0 {
		t.Fatal(probs)
	}
	st := &fakeStore{places: map[int64]bool{10: false, 11: true}}
	acts, probs, err := Plan(context.Background(), st, rows)
	if err != nil {
		t.Fatal(err)
	}
	if acts != nil || len(probs) != 1 || probs[0].Line != 4 || !strings.Contains(probs[0].Msg, "does not exist") {
		t.Fatalf("acts %v probs %v", acts, probs)
	}
	if len(st.written) != 0 {
		t.Fatal("Plan wrote")
	}

	acts, probs, err = Plan(context.Background(), st, rows[:2])
	if err != nil || len(probs) != 0 || len(acts) != 2 || acts[0].Update || !acts[1].Update {
		t.Fatalf("acts %+v probs %v err %v", acts, probs, err)
	}
}

// The jsonb the importer writes is hours.Schedule's own marshalling, which the TS reader
// (apps/api/src/hours/schedule.ts validateSchedule) accepts. This pins a few cases in a golden
// file that apps/api/src/hours-pilot/importer-schedules.spec.ts feeds to the TS reader.
// Regenerate with HOURS_PILOT_UPDATE_GOLDEN=1 go test ./cmd/hours-pilot-import.
func TestGoldenSchedulesForTheTSReader(t *testing.T) {
	inputs := []string{
		"Mo-Fr 09:00-17:00",
		"Mo-Su 17:00-02:00",
		"Mo-Fr 11:30-14:00,17:00-22:00; Sa,Su 12:00-23:00",
		"24/7",
		"Tu-Su 10:00-18:00; PH off",
	}
	got := map[string]json.RawMessage{}
	for _, in := range inputs {
		rows, probs := ParseCSV(strings.NewReader(header + `1,EV,A,,,,"` + in + `",seen on the door,2026-11-18` + "\r\n"))
		if len(probs) > 0 || len(rows) != 1 {
			t.Fatalf("%q: %v", in, probs)
		}
		got[in] = rows[0].Schedule
	}
	b, err := json.MarshalIndent(got, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	b = append(b, '\n')
	path := filepath.Join("..", "..", "..", "apps", "api", "src", "hours-pilot", "testdata", "importer-schedules.json")
	if os.Getenv("HOURS_PILOT_UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile(path, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.ReplaceAll(string(want), "\r\n", "\n") != string(b) {
		t.Errorf("golden file is stale; run with HOURS_PILOT_UPDATE_GOLDEN=1")
	}
}
