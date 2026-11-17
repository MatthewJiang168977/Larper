package hours

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMarshalIsStableAndComplete(t *testing.T) {
	// Built out of order, with nil slices and overlapping spans.
	s := Schedule{
		Weekly: []WeeklySpan{{2, 600, 700}, {1, 700, 800}, {1, 540, 720}},
		Dates: []DateRule{
			{On: "2026-12-25", Closed: true},
			{On: "--12-24", Spans: []Span{{600, 700}, {650, 900}}},
		},
	}
	got, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"v":1,"tz":"America/New_York","always":false,` +
		`"weekly":[{"d":1,"from":540,"to":800},{"d":2,"from":600,"to":700}],` +
		`"dates":[{"on":"--12-24","closed":false,"spans":[{"from":600,"to":900}]},` +
		`{"on":"2026-12-25","closed":true,"spans":[]}],` +
		`"holidays":null,"partial":"none"}`
	if string(got) != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}

	empty, _ := json.Marshal(Schedule{Always: true})
	if !strings.Contains(string(empty), `"weekly":[],"dates":[],"holidays":null`) {
		t.Fatalf("empty slices must marshal as [], got %s", empty)
	}
}

func TestNormalizeMergesAndSorts(t *testing.T) {
	s := Schedule{Weekly: []WeeklySpan{{3, 900, 1000}, {3, 500, 600}, {3, 600, 700}, {3, 650, 800}, {1, 0, 10}}}
	s.Normalize()
	want := []WeeklySpan{{1, 0, 10}, {3, 500, 800}, {3, 900, 1000}}
	if mustJSON(s.Weekly) != mustJSON(want) {
		t.Fatalf("got %v want %v", s.Weekly, want)
	}
	if err := s.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestNormalizeDatesLastWins(t *testing.T) {
	s := Schedule{Dates: []DateRule{{On: "--12-25", Closed: true}, {On: "--12-25", Spans: []Span{{600, 700}}}}}
	s.Normalize()
	if len(s.Dates) != 1 || s.Dates[0].Closed {
		t.Fatalf("got %+v", s.Dates)
	}
}

func TestNormalizeAlwaysClearsWeekly(t *testing.T) {
	s := Schedule{Always: true, Weekly: []WeeklySpan{{1, 0, 10}}}
	s.Normalize()
	if len(s.Weekly) != 0 {
		t.Fatal("always schedules have no weekly spans")
	}
}

func TestValidate(t *testing.T) {
	ok := func() Schedule {
		s := Schedule{Weekly: []WeeklySpan{{1, 540, 1020}}, Dates: []DateRule{{On: "--12-25", Closed: true}}}
		s.Normalize()
		return s
	}
	if s := ok(); s.Validate() != nil {
		t.Fatal(s.Validate())
	}
	closed := "closed"
	bogus := "sometimes"
	cases := map[string]func(*Schedule){
		"version":          func(s *Schedule) { s.V = 2 },
		"tz":               func(s *Schedule) { s.TZ = "UTC" },
		"partial":          func(s *Schedule) { s.Partial = "maybe" },
		"holidays":         func(s *Schedule) { s.Holidays = &bogus },
		"weekday 0":        func(s *Schedule) { s.Weekly[0].D = 0 },
		"weekday 8":        func(s *Schedule) { s.Weekly[0].D = 8 },
		"from negative":    func(s *Schedule) { s.Weekly[0].From = -1 },
		"from 1440":        func(s *Schedule) { s.Weekly[0].From = 1440 },
		"to = from":        func(s *Schedule) { s.Weekly[0].To = 540 },
		"to > 2880":        func(s *Schedule) { s.Weekly[0].To = 2881 },
		"unsorted":         func(s *Schedule) { s.Weekly = []WeeklySpan{{2, 0, 10}, {1, 0, 10}} },
		"overlap":          func(s *Schedule) { s.Weekly = []WeeklySpan{{1, 0, 10}, {1, 5, 20}} },
		"touching":         func(s *Schedule) { s.Weekly = []WeeklySpan{{1, 0, 10}, {1, 10, 20}} },
		"always + weekly":  func(s *Schedule) { s.Always = true },
		"always + holiday": func(s *Schedule) { s.Weekly, s.Dates, s.Always, s.Holidays = nil, nil, true, &closed },
		"bad date":         func(s *Schedule) { s.Dates[0].On = "2026-02-30" },
		"bad yearly date":  func(s *Schedule) { s.Dates[0].On = "--13-01" },
		"short date":       func(s *Schedule) { s.Dates[0].On = "2026-1-2" },
		"closed + spans":   func(s *Schedule) { s.Dates[0].Spans = []Span{{1, 2}} },
		"open, no spans":   func(s *Schedule) { s.Dates[0].Closed = false },
		"repeated date":    func(s *Schedule) { s.Dates = append(s.Dates, s.Dates[0]) },
		"date span range":  func(s *Schedule) { s.Dates[0].Closed, s.Dates[0].Spans = false, []Span{{5, 5}} },
	}
	for name, mutate := range cases {
		s := ok()
		mutate(&s)
		if err := s.Validate(); err == nil {
			t.Errorf("%s: Validate passed", name)
		}
	}
	leap := Schedule{Dates: []DateRule{{On: "--02-29", Closed: true}}}
	leap.Normalize()
	if err := leap.Validate(); err != nil {
		t.Errorf("--02-29 is a valid yearly date: %v", err)
	}
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}
