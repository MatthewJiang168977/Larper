// Package hours parses opening hours (OpenStreetMap opening_hours, schema.org) into one
// normalized weekly schedule and evaluates it: open, closed or unknown at an instant,
// always in America/New_York.
//
// The package is pure: no database, no data files. A venue's different services
// (regular hours, kitchen, bar) are separate Schedules; a Schedule has no "kind".
//
// # The normalized schedule (version 1)
//
// A TypeScript evaluator in the API reads the same JSON, so this format is a contract.
// SCHEDULE.md next to this file repeats it. Every key is always present:
//
//		{
//		  "v": 1,
//		  "tz": "America/New_York",
//		  "always": false,
//		  "weekly": [ { "d": 1, "from": 540, "to": 1020 } ],
//		  "dates":  [ { "on": "2026-12-25", "closed": true,  "spans": [] },
//		              { "on": "--12-24",    "closed": false, "spans": [ { "from": 540, "to": 900 } ] } ],
//		  "holidays": null,
//		  "partial": "none"
//		}
//
//	  - d is the ISO weekday, 1 = Monday ... 7 = Sunday: the local day the span STARTS on.
//	  - from is minutes after local midnight, 0..1439. to is minutes after the SAME
//	    midnight, from+1..2880; to > 1440 runs past midnight into the next day (Fri
//	    22:00-02:00 is {d:5, from:1320, to:1560}). Closing at "24:00" is 1440; a day open
//	    all day is {from:0, to:1440}. from is inclusive, to is exclusive.
//	  - Several spans on one day are split shifts. Spans of a day are sorted by from and
//	    do not overlap or touch (Normalize merges them). weekly is sorted by (d, from).
//	  - always: open 24/7. Then weekly is empty, dates is empty and holidays is null.
//	  - dates overrides a local calendar date the span STARTS on. on is "YYYY-MM-DD" (one
//	    date) or "--MM-DD" (every year). An entry is either closed:true (spans empty) or
//	    has spans (same shape without d). A specific-year entry beats a yearly one. An
//	    override replaces the weekly spans that START on that date; a span from the
//	    previous day that runs past midnight still applies.
//	  - holidays is what the source says about public holidays: "closed", "open" (same as
//	    the weekday) or null (not stated). See PublicHolidays for which days count.
//	  - partial is "none", "additive" or "restrictive": set when part of the source could
//	    not be understood. additive: what was dropped could only ADD open time, so a
//	    computed "closed" can't be trusted. restrictive: it might REMOVE open time (or we
//	    couldn't tell), so "open" can't be trusted either.
//
// Missing hours are never "closed": a nil *Schedule evaluates to Unknown.
package hours

import (
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

// Version is the schedule format version.
const Version = 1

// MaxDates is the most dated exceptions a schedule may carry: a year's worth, leap day
// included. More is invalid (the API's validateSchedule has the same cap).
const MaxDates = 366

// TimeZone is the only time zone schedules are evaluated in.
const TimeZone = "America/New_York"

// Partial says how much of the source we understood.
type Partial string

const (
	PartialNone        Partial = "none"
	PartialAdditive    Partial = "additive"
	PartialRestrictive Partial = "restrictive"
)

// Values of Schedule.Holidays.
const (
	HolidaysClosed = "closed"
	HolidaysOpen   = "open"
)

// Span is a stretch of open time on one local day, in minutes after that day's midnight.
type Span struct {
	From int `json:"from"`
	To   int `json:"to"`
}

// WeeklySpan is a Span that repeats every week; D is the ISO weekday it starts on.
type WeeklySpan struct {
	D    int `json:"d"`
	From int `json:"from"`
	To   int `json:"to"`
}

// DateRule overrides the spans that start on one date (or one month-day every year).
type DateRule struct {
	On     string `json:"on"`
	Closed bool   `json:"closed"`
	Spans  []Span `json:"spans"`
}

// MarshalJSON always emits spans as an array, never null.
func (r DateRule) MarshalJSON() ([]byte, error) {
	type plain DateRule
	p := plain(r)
	if p.Spans == nil {
		p.Spans = []Span{}
	}
	return json.Marshal(p)
}

// Schedule is the normalized opening-hours format described in the package comment.
type Schedule struct {
	V        int          `json:"v"`
	TZ       string       `json:"tz"`
	Always   bool         `json:"always"`
	Weekly   []WeeklySpan `json:"weekly"`
	Dates    []DateRule   `json:"dates"`
	Holidays *string      `json:"holidays"`
	Partial  Partial      `json:"partial"`
}

// MarshalJSON normalizes a copy first, so the output is deterministic whatever order
// the schedule was built in, and every key is present (empty arrays, null holidays).
func (s Schedule) MarshalJSON() ([]byte, error) {
	type plain Schedule
	s.Normalize()
	return json.Marshal(plain(s))
}

// Normalize fills defaults, sorts, and merges overlapping or touching spans so that the
// schedule is canonical. Spans out of range are left alone for Validate to report. It
// replaces the slices it touches instead of editing them in place.
func (s *Schedule) Normalize() {
	if s.V == 0 {
		s.V = Version
	}
	if s.TZ == "" {
		s.TZ = TimeZone
	}
	if s.Partial == "" {
		s.Partial = PartialNone
	}
	if s.Always {
		s.Weekly = nil
	}
	s.Weekly = normalizeWeekly(s.Weekly)
	s.Dates = normalizeDates(s.Dates)
}

func normalizeWeekly(in []WeeklySpan) []WeeklySpan {
	out := append([]WeeklySpan{}, in...)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.D != b.D {
			return a.D < b.D
		}
		if a.From != b.From {
			return a.From < b.From
		}
		return a.To < b.To
	})
	merged := out[:0]
	for _, w := range out {
		if n := len(merged); n > 0 && merged[n-1].D == w.D && w.From <= merged[n-1].To {
			merged[n-1].To = max(merged[n-1].To, w.To)
			continue
		}
		merged = append(merged, w)
	}
	return merged
}

// mergeSpans sorts spans and merges overlapping or touching ones into a new slice.
func mergeSpans(in []Span) []Span {
	out := append([]Span{}, in...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].From != out[j].From {
			return out[i].From < out[j].From
		}
		return out[i].To < out[j].To
	})
	merged := out[:0]
	for _, sp := range out {
		if n := len(merged); n > 0 && sp.From <= merged[n-1].To {
			merged[n-1].To = max(merged[n-1].To, sp.To)
			continue
		}
		merged = append(merged, sp)
	}
	return merged
}

// normalizeDates sorts by "on" and keeps the last entry when an "on" repeats.
func normalizeDates(in []DateRule) []DateRule {
	last := make(map[string]DateRule, len(in))
	for _, r := range in {
		if r.Closed {
			r.Spans = nil
		}
		r.Spans = mergeSpans(r.Spans)
		last[r.On] = r
	}
	out := make([]DateRule, 0, len(last))
	for _, r := range last {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].On < out[j].On })
	return out
}

// Validate reports the first way the schedule breaks the format. Run Normalize first
// when the schedule was built by hand.
func (s *Schedule) Validate() error {
	if s.V != Version {
		return fmt.Errorf("hours: unsupported version %d", s.V)
	}
	if s.TZ != TimeZone {
		return fmt.Errorf("hours: tz %q, only %s is supported", s.TZ, TimeZone)
	}
	switch s.Partial {
	case PartialNone, PartialAdditive, PartialRestrictive:
	default:
		return fmt.Errorf("hours: partial %q", s.Partial)
	}
	if s.Holidays != nil && *s.Holidays != HolidaysClosed && *s.Holidays != HolidaysOpen {
		return fmt.Errorf("hours: holidays %q", *s.Holidays)
	}
	if len(s.Dates) > MaxDates {
		return fmt.Errorf("hours: %d dates, at most %d", len(s.Dates), MaxDates)
	}
	if s.Always && (len(s.Weekly) > 0 || len(s.Dates) > 0 || s.Holidays != nil) {
		return fmt.Errorf("hours: always schedule must have no weekly spans, dates or holidays")
	}
	for i, w := range s.Weekly {
		if w.D < 1 || w.D > 7 {
			return fmt.Errorf("hours: weekly[%d]: weekday %d", i, w.D)
		}
		if err := checkSpan(Span{w.From, w.To}); err != nil {
			return fmt.Errorf("hours: weekly[%d]: %w", i, err)
		}
		if i > 0 {
			p := s.Weekly[i-1]
			if w.D < p.D || (w.D == p.D && w.From <= p.To) {
				return fmt.Errorf("hours: weekly[%d] is out of order or overlaps weekly[%d]", i, i-1)
			}
		}
	}
	for i, r := range s.Dates {
		if !validDateKey(r.On) {
			return fmt.Errorf("hours: dates[%d]: bad date %q", i, r.On)
		}
		if i > 0 && r.On <= s.Dates[i-1].On {
			return fmt.Errorf("hours: dates[%d]: %q is out of order or repeated", i, r.On)
		}
		if r.Closed && len(r.Spans) > 0 {
			return fmt.Errorf("hours: dates[%d]: closed with spans", i)
		}
		if !r.Closed && len(r.Spans) == 0 {
			return fmt.Errorf("hours: dates[%d]: neither closed nor any spans", i)
		}
		for j, sp := range r.Spans {
			if err := checkSpan(sp); err != nil {
				return fmt.Errorf("hours: dates[%d].spans[%d]: %w", i, j, err)
			}
			if j > 0 && sp.From <= r.Spans[j-1].To {
				return fmt.Errorf("hours: dates[%d].spans[%d] is out of order or overlaps", i, j)
			}
		}
	}
	return nil
}

func checkSpan(sp Span) error {
	if sp.From < 0 || sp.From > 1439 {
		return fmt.Errorf("from %d out of range 0..1439", sp.From)
	}
	if sp.To <= sp.From || sp.To > 2880 {
		return fmt.Errorf("to %d out of range %d..2880", sp.To, sp.From+1)
	}
	return nil
}

// validDateKey accepts "YYYY-MM-DD" and "--MM-DD" (checked against a leap year, so
// "--02-29" is fine).
func validDateKey(on string) bool {
	if len(on) == 7 && on[:2] == "--" {
		_, err := time.Parse("2006-01-02", "2000-"+on[2:])
		return err == nil
	}
	if len(on) == 10 {
		_, err := time.Parse("2006-01-02", on)
		return err == nil
	}
	return false
}
