package hours

import (
	"testing"
	"time"
)

func mustAt(t *testing.T, s string) time.Time {
	t.Helper()
	at, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatal(err)
	}
	return at
}

func mustParseOSM(t *testing.T, s string) *Schedule {
	t.Helper()
	sch, _, err := ParseOSM(s)
	if err != nil {
		t.Fatalf("%q: %v", s, err)
	}
	return &sch
}

func TestSpansOn(t *testing.T) {
	s := mustParseOSM(t, "Mo-Fr 11:30-14:30,17:00-22:00; Fr,Sa 17:00-02:00; Su 10:00-24:00; Dec 24 09:00-15:00; Dec 25 off")
	day := func(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }
	cases := []struct {
		date time.Time
		want []DaySpan
	}{
		{day(2026, 7, 6), []DaySpan{{"11:30", "14:30", false}, {"17:00", "22:00", false}}}, // Monday
		{day(2026, 7, 10), []DaySpan{{"17:00", "02:00", true}}},                            // Friday
		{day(2026, 7, 11), []DaySpan{{"17:00", "02:00", true}}},                            // Saturday
		{day(2026, 7, 12), []DaySpan{{"10:00", "24:00", false}}},                           // Sunday
		{day(2026, 12, 24), []DaySpan{{"09:00", "15:00", false}}},                          // override
		{day(2026, 12, 25), nil},                                                           // closed
	}
	for _, c := range cases {
		got := SpansOn(s, c.date)
		if mustJSON(got) != mustJSON(c.want) {
			t.Errorf("%s: got %v, want %v", c.date.Format("2006-01-02"), got, c.want)
		}
	}
	if SpansOn(nil, day(2026, 7, 6)) != nil {
		t.Error("nil schedule has no spans")
	}
	if got := SpansOn(&Schedule{Always: true}, day(2026, 7, 6)); len(got) != 1 || got[0].To != "24:00" {
		t.Errorf("always: %v", got)
	}
	// A span to 2880 ends at the end of the next day.
	e := &Schedule{Weekly: []WeeklySpan{{6, 1320, 2880}}}
	if got := SpansOn(e, day(2026, 7, 11)); len(got) != 1 || got[0].To != "24:00" || !got[0].NextDay {
		t.Errorf("to 2880: %v", got)
	}
}

func TestNextChange(t *testing.T) {
	s := mustParseOSM(t, "Mo-Fr 09:00-17:00")
	cases := []struct {
		from string
		want string
		to   State
	}{
		{"2026-07-06T12:00:00Z", "2026-07-06T13:00:00Z", Open},   // Mon 08:00 EDT: opens at 09:00
		{"2026-07-06T14:00:00Z", "2026-07-06T21:00:00Z", Closed}, // Mon 10:00: closes at 17:00
		{"2026-07-06T14:00:30Z", "2026-07-06T21:00:00Z", Closed}, // seconds don't matter
		{"2026-07-06T13:00:00Z", "2026-07-06T21:00:00Z", Closed}, // exactly at opening
		{"2026-07-06T20:59:59Z", "2026-07-06T21:00:00Z", Closed}, // one second before closing
		{"2026-07-06T21:00:00Z", "2026-07-07T13:00:00Z", Open},   // closed at 17:00 sharp: tomorrow
		{"2026-07-10T21:30:00Z", "2026-07-13T13:00:00Z", Open},   // Fri 17:30: Monday 09:00
		{"2026-07-11T04:00:00Z", "2026-07-13T13:00:00Z", Open},   // Sat 00:00: Monday 09:00
		{"2026-01-05T13:59:59Z", "2026-01-05T14:00:00Z", Open},   // EST: 09:00 is 14:00Z
		{"2026-03-06T22:00:00Z", "2026-03-09T13:00:00Z", Open},   // Fri 17:00 EST: Mon 09:00 EDT
		{"2026-11-06T22:00:00Z", "2026-11-09T14:00:00Z", Open},   // Fri 17:00 EST: Mon 09:00 EST
		{"2026-07-04T04:00:00Z", "2026-07-05T04:00:00Z", Closed}, // Jul 4 is unknown (no word on holidays), Jul 5 is closed
	}
	for _, c := range cases {
		at, to, ok := NextChange(s, mustAt(t, c.from))
		if !ok || to != c.to || !at.Equal(mustAt(t, c.want)) {
			t.Errorf("%s: got %v %s %v, want %s %s", c.from, at, to, ok, c.want, c.to)
		}
		if ok && at.Location() != NYC {
			t.Errorf("%s: result not in New York time", c.from)
		}
	}
}

func TestNextChangeEdges(t *testing.T) {
	if _, _, ok := NextChange(nil, time.Now()); ok {
		t.Error("nil schedule has no change")
	}
	if _, _, ok := NextChange(&Schedule{Always: true}, time.Now()); ok {
		t.Error("always never changes")
	}
	if _, _, ok := NextChange(&Schedule{Partial: PartialRestrictive, Weekly: []WeeklySpan{{1, 0, 10}}}, time.Now()); ok {
		t.Error("restrictive is unknown throughout")
	}
	// Overnight spans change at their end, on the next day.
	s := mustParseOSM(t, "Fr 22:00-02:00")
	at, to, ok := NextChange(s, mustAt(t, "2026-07-11T03:00:00Z")) // Fri 23:00 EDT
	if !ok || to != Closed || !at.Equal(mustAt(t, "2026-07-11T06:00:00Z")) {
		t.Errorf("overnight: %v %s %v", at, to, ok)
	}
	// Further than 7 days away: no change reported.
	openH := HolidaysOpen
	far := &Schedule{Holidays: &openH, Dates: []DateRule{{On: "2026-07-20", Spans: []Span{{600, 700}}}}}
	if _, _, ok := NextChange(far, mustAt(t, "2026-07-01T00:00:00Z")); ok {
		t.Error("a change 19 days away is out of range")
	}
	// Fall back: a repeated wall-clock hour is not a change.
	fb := mustParseOSM(t, "Su 01:00-01:30")
	at, to, ok = NextChange(fb, mustAt(t, "2026-11-01T05:10:00Z")) // 01:10 EDT
	if !ok || to != Closed || !at.Equal(mustAt(t, "2026-11-01T05:30:00Z")) {
		t.Errorf("fall back: %v %s %v", at, to, ok)
	}
	at, to, ok = NextChange(fb, mustAt(t, "2026-11-01T05:40:00Z")) // 01:40 EDT, closed
	if !ok || to != Open || !at.Equal(mustAt(t, "2026-11-01T06:00:00Z")) {
		t.Errorf("fall back, between the two: %v %s %v", at, to, ok)
	}
}

func TestStateAtUnknownHolidayVersusTail(t *testing.T) {
	// A closed day with no spans on Christmas is still unknown when holidays is null.
	s := mustParseOSM(t, "Mo-Th 09:00-17:00")
	if got := StateAt(s, mustAt(t, "2026-12-25T17:00:00Z")); got != Unknown {
		t.Fatalf("Christmas (a Friday, no rule), holidays unstated: %s", got)
	}
	if got := StateAt(s, mustAt(t, "2026-12-26T17:00:00Z")); got != Closed {
		t.Fatalf("an ordinary Saturday: %s", got)
	}
}
