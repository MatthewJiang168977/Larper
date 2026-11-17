package hours

import (
	"fmt"
	"time"
	// Embeds the IANA zone database (~450 KB) so time.LoadLocation works without a system
	// one: the workers run on distroless images and on Windows dev machines, neither of
	// which ships zoneinfo.
	_ "time/tzdata"
)

// State is whether a place is open at an instant.
type State string

const (
	Open    State = "open"
	Closed  State = "closed"
	Unknown State = "unknown"
)

// NYC is the zone every schedule is evaluated in.
var NYC = mustLoadNYC()

func mustLoadNYC() *time.Location {
	loc, err := time.LoadLocation(TimeZone)
	if err != nil {
		panic("hours: " + err.Error()) // can't happen: time/tzdata is embedded
	}
	return loc
}

// civil is a calendar date, independent of any zone.
type civil struct {
	y int
	m time.Month
	d int
}

func (c civil) addDays(n int) civil {
	t := time.Date(c.y, c.m, c.d+n, 0, 0, 0, 0, time.UTC)
	return civil{t.Year(), t.Month(), t.Day()}
}

// isoWeekday is 1 = Monday ... 7 = Sunday.
func (c civil) isoWeekday() int {
	wd := time.Date(c.y, c.m, c.d, 0, 0, 0, 0, time.UTC).Weekday()
	return (int(wd)+6)%7 + 1
}

func (c civil) String() string { return fmt.Sprintf("%04d-%02d-%02d", c.y, int(c.m), c.d) }

func (c civil) yearly() string { return fmt.Sprintf("--%02d-%02d", int(c.m), c.d) }

// override returns the dates entry for the date: a specific-year entry beats a yearly one.
func (s *Schedule) override(c civil) *DateRule {
	exact, yearly := c.String(), c.yearly()
	var found *DateRule
	for i := range s.Dates {
		switch s.Dates[i].On {
		case exact:
			return &s.Dates[i]
		case yearly:
			found = &s.Dates[i]
		}
	}
	return found
}

// spansStarting returns the spans that start on a local date, and whether they're in
// doubt because the date is a public holiday and the source said nothing about holidays.
func (s *Schedule) spansStarting(c civil) (spans []Span, doubt bool) {
	if r := s.override(c); r != nil {
		if r.Closed {
			return nil, false
		}
		return r.Spans, false
	}
	if _, ok := HolidayOn(c.y, c.m, c.d); ok {
		switch {
		case s.Holidays == nil:
			doubt = true
		case *s.Holidays == HolidaysClosed:
			return nil, false
		}
	}
	wd := c.isoWeekday()
	for _, w := range s.Weekly {
		if w.D == wd {
			spans = append(spans, Span{w.From, w.To})
		}
	}
	return spans, doubt
}

// StateAt says whether the schedule is open at t. A nil schedule is Unknown: missing
// hours are never "closed".
//
// Spans are local wall-clock times, so t is read as a local date and minute of day in
// New York; nothing is ever added to a midnight. That decides DST: on the spring-forward
// day (02:00 jumps to 03:00) the missing hour simply never occurs, so a span 01:00-04:00
// is open at 01:30 EST and at 03:30 EDT, and one that closes at 02:30 effectively closes
// at 03:00 EDT. On the fall-back day each wall-clock minute from 01:00 to 01:59 happens
// twice and both get the same answer, so a span ending 01:30 is open through the first
// 01:00-01:30 and again through the repeated one, and an overnight Saturday 22:00-02:00
// covers both 01:xx hours.
//
// A span belongs to the date it starts on. That date decides everything about it: a
// dates override replaces its weekly spans, and a public holiday closes it (holidays
// "closed"), leaves it alone ("open"), or puts it in doubt (null: venues often change
// hours on holidays and we weren't told, so the answer is Unknown). Open spans that
// aren't in doubt win over doubt. Yesterday's holiday only casts doubt over today if it
// has a span that reaches into today at this minute.
//
// Finally partial applies: additive turns closed into Unknown, restrictive turns
// everything into Unknown.
func StateAt(s *Schedule, t time.Time) State {
	if s == nil {
		return Unknown
	}
	st := stateAtLocal(s, t.In(NYC))
	switch s.Partial {
	case PartialAdditive:
		if st == Closed {
			st = Unknown
		}
	case PartialRestrictive:
		st = Unknown
	}
	return st
}

func stateAtLocal(s *Schedule, local time.Time) State {
	if s.Always {
		return Open
	}
	y, m, d := local.Date()
	today := civil{y, m, d}
	minute := local.Hour()*60 + local.Minute()

	open, doubt := false, false
	spans, dubious := s.spansStarting(today)
	if dubious {
		doubt = true
	} else {
		for _, sp := range spans {
			if sp.From <= minute && minute < sp.To {
				open = true
			}
		}
	}
	spans, dubious = s.spansStarting(today.addDays(-1))
	for _, sp := range spans {
		if sp.To > 1440 && minute < sp.To-1440 {
			if dubious {
				doubt = true
			} else {
				open = true
			}
		}
	}
	switch {
	case open:
		return Open
	case doubt:
		return Unknown
	}
	return Closed
}

// DaySpan is one span of a day for display. To is "HH:MM", or "24:00" for midnight at
// the end of the day; NextDay says the span ends on the following day ("02:00" with
// NextDay is 2 am the next morning).
type DaySpan struct {
	From    string `json:"from"`
	To      string `json:"to"`
	NextDay bool   `json:"nextDay"`
}

// SpansOn returns the spans that start on the local date, as "HH:MM" pairs for display.
// Only the date's own year, month and day are used (not its zone). It returns the
// regular spans even when the date is a holiday the source didn't mention and when the
// schedule is partial; use StateAt for what's actually known. A nil schedule has none.
func SpansOn(s *Schedule, date time.Time) []DaySpan {
	if s == nil {
		return nil
	}
	if s.Always {
		return []DaySpan{{From: "00:00", To: "24:00"}}
	}
	y, m, d := date.Date()
	spans, _ := s.spansStarting(civil{y, m, d})
	var out []DaySpan
	for _, sp := range spans {
		ds := DaySpan{From: clock(sp.From)}
		if sp.To > 1440 {
			ds.NextDay = true
			ds.To = clock(sp.To - 1440)
		} else {
			ds.To = clock(sp.To)
		}
		out = append(out, ds)
	}
	return out
}

// clock formats minutes as "HH:MM"; 1440 is "24:00".
func clock(min int) string {
	return fmt.Sprintf("%02d:%02d", min/60, min%60)
}

// NextChange finds when the state next changes within 7 days of t, and what it changes
// to. ok is false when it doesn't (including a nil schedule). It checks minute by
// minute with StateAt, so it follows every rule of StateAt, and the instant it returns
// is on a whole minute.
func NextChange(s *Schedule, t time.Time) (at time.Time, to State, ok bool) {
	if s == nil {
		return time.Time{}, Unknown, false
	}
	start := t.Truncate(time.Minute)
	now := StateAt(s, t)
	for i := 1; i <= 7*24*60; i++ {
		c := start.Add(time.Duration(i) * time.Minute)
		if st := StateAt(s, c); st != now {
			return c.In(NYC), st, true
		}
	}
	return time.Time{}, Unknown, false
}
