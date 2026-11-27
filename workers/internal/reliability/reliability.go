// Package reliability estimates, per place, the probability that it is open and as described
// (docs/plans/quality-engine.md, section 2). Pure: the result is a function of the set of
// reports (and an earlier suspension), so replays and out-of-order delivery agree.
package reliability

import (
	"math"
	"sort"
	"time"
)

// Kind is what was reported; the values are place_reports.kind.
type Kind string

const (
	CheckedIn     Kind = "checked_in"
	ConfirmedOpen Kind = "confirmed_open"
	WasntOpen     Kind = "wasnt_open"
	SkippedClosed Kind = "skipped_closed"
	HandVerified  Kind = "hand_verified"
	HandClosed    Kind = "hand_closed"
)

// The estimate is Beta-Bernoulli: score = (PriorSuccess + S) / (PriorSuccess + S + PriorFailure + F),
// S and F being weighted reports, each halved every HalfLife. The API decays the stored S and F
// to "now" with the same constants (apps/api/src/quests/reliability.ts; a test there reads this
// file).
const (
	PriorSuccess = 4.0
	PriorFailure = 1.0
	// HalfLifeDays: places change over months, and hand-verified hours expire at 90 days.
	HalfLifeDays = 60.0
	// SuspendBelow: a place whose score falls under this is not offered until a hand verification.
	SuspendBelow = 0.6
	// TwoReportsWindowDays: two people's "wasn't open" this close together suspend a place
	// however many successes came before.
	TwoReportsWindowDays = 60.0
)

type weight struct {
	success bool
	w       float64
	// rank decides between the reports of one visit: a failure beats a success, and a
	// "yes" beats saying nothing.
	rank int
}

var weights = map[Kind]weight{
	HandVerified:  {true, 1.5, 0},
	HandClosed:    {false, 10, 0},
	WasntOpen:     {false, 1, 4},
	SkippedClosed: {false, 0.75, 3},
	ConfirmedOpen: {true, 1, 2},
	CheckedIn:     {true, 0.5, 1},
}

// Report is one row of place_reports.
type Report struct {
	ID     string // event id, the tiebreak between equal times
	Kind   Kind
	UserID int64 // 0 for the curator's verdicts
	Visit  int64 // the quest
	At     time.Time
}

// Result is a place_reliability row.
type Result struct {
	Successes, Failures float64 // as they stood at AsOf
	AsOf                time.Time
	SuspendedAt         *time.Time
}

func hand(k Kind) bool { return k == HandVerified || k == HandClosed }

func decay(from, to time.Time) float64 {
	return math.Pow(0.5, math.Max(0, to.Sub(from).Hours()/24)/HalfLifeDays)
}

// Score is the estimate at `at` for the stored evidence.
func Score(successes, failures float64, asOf, at time.Time) float64 {
	d := decay(asOf, at)
	return (PriorSuccess + successes*d) / (PriorSuccess + successes*d + PriorFailure + failures*d)
}

// state is the evidence the reports (sorted by time) amount to at the time of the last one.
func state(reports []Report) (successes, failures float64, suspend bool) {
	at := reports[len(reports)-1].At

	// The latest hand verdict discards everything before it.
	last := -1
	for i, r := range reports {
		if hand(r.Kind) {
			last = i
		}
	}
	add := func(r Report) {
		w := weights[r.Kind]
		if w.success {
			successes += w.w * decay(r.At, at)
		} else {
			failures += w.w * decay(r.At, at)
		}
	}
	if last >= 0 {
		add(reports[last])
		suspend = reports[last].Kind == HandClosed
	}

	// One person counts once: their latest visit, and the strongest thing said about it.
	latest := map[int64]Report{}
	for _, r := range reports[last+1:] {
		have, ok := latest[r.UserID]
		switch {
		case !ok || (r.Visit != have.Visit && !r.At.Before(have.At)):
			latest[r.UserID] = r
		case r.Visit == have.Visit && weights[r.Kind].rank > weights[have.Kind].rank:
			latest[r.UserID] = r
		}
	}
	var wasnt []time.Time
	users := make([]int64, 0, len(latest))
	for u := range latest {
		users = append(users, u)
	}
	sort.Slice(users, func(i, j int) bool { return users[i] < users[j] }) // a stable float sum
	for _, u := range users {
		r := latest[u]
		add(r)
		if r.Kind == WasntOpen {
			wasnt = append(wasnt, r.At)
		}
	}
	sort.Slice(wasnt, func(i, j int) bool { return wasnt[i].Before(wasnt[j]) })
	for i := 1; i < len(wasnt); i++ {
		if wasnt[i].Sub(wasnt[i-1]).Hours()/24 <= TwoReportsWindowDays {
			suspend = true
		}
	}
	if Score(successes, failures, at, at) < SuspendBelow {
		suspend = true
	}
	return successes, failures, suspend
}

// Compute works the place's row out of all its reports. suspendedBefore is the stored
// suspension, if any: it stays (even if the evidence for it has since been deleted) unless a
// hand verification was made after it.
func Compute(reports []Report, suspendedBefore *time.Time, now time.Time) Result {
	sorted := append([]Report(nil), reports...)
	sort.Slice(sorted, func(i, j int) bool {
		if !sorted[i].At.Equal(sorted[j].At) {
			return sorted[i].At.Before(sorted[j].At)
		}
		return sorted[i].ID < sorted[j].ID
	})

	res := Result{AsOf: now}
	var suspended *time.Time
	if suspendedBefore != nil {
		t := *suspendedBefore
		suspended = &t
	}
	// Walk the history, so a suspension doesn't depend on when this runs and decay never lifts it.
	for i, r := range sorted {
		s, f, suspend := state(sorted[:i+1])
		res.Successes, res.Failures, res.AsOf = s, f, r.At
		if r.Kind == HandVerified && suspended != nil && !r.At.Before(*suspended) {
			suspended = nil
		}
		if suspend && suspended == nil {
			t := r.At
			suspended = &t
		}
	}
	res.SuspendedAt = suspended
	return res
}
