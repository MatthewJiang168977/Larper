package reliability

import (
	"math"
	"math/rand"
	"strconv"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)

func day(n int) time.Time { return t0.AddDate(0, 0, n) }

var seq int

// rep is one report by a user on a visit of their own.
func rep(k Kind, user int64, d int) Report {
	seq++
	r := Report{ID: strconv.Itoa(seq), Kind: k, UserID: user, Visit: int64(seq), At: day(d)}
	if hand(k) {
		r.UserID, r.Visit = 0, 0
	}
	return r
}

func compute(reports ...Report) Result { return Compute(reports, nil, day(100)) }

func score(r Result) float64 { return Score(r.Successes, r.Failures, r.AsOf, r.AsOf) }

func TestOneReportNeverSuspends(t *testing.T) {
	for _, k := range []Kind{WasntOpen, SkippedClosed, ConfirmedOpen, CheckedIn} {
		if r := compute(rep(k, 1, 0)); r.SuspendedAt != nil {
			t.Errorf("%s alone suspended", k)
		}
	}
	if got := score(compute(rep(WasntOpen, 1, 0))); math.Abs(got-4.0/6) > 1e-9 {
		t.Errorf("score %v", got)
	}
}

func TestTwoPeoplesWasntOpenSuspends(t *testing.T) {
	if compute(rep(WasntOpen, 1, 0), rep(WasntOpen, 2, 10)).SuspendedAt == nil {
		t.Error("two people did not suspend")
	}
	// Whatever succeeded before.
	many := []Report{}
	for u := int64(10); u < 30; u++ {
		many = append(many, rep(ConfirmedOpen, u, 0))
	}
	many = append(many, rep(WasntOpen, 1, 1), rep(WasntOpen, 2, 2))
	if compute(many...).SuspendedAt == nil {
		t.Error("successes hid two wasn't-open reports")
	}
	// One person twice is one person.
	if compute(rep(WasntOpen, 1, 0), rep(WasntOpen, 1, 10)).SuspendedAt != nil {
		t.Error("one person suspended a place")
	}
}

func TestHandVerificationOutweighsAndLifts(t *testing.T) {
	suspended := []Report{rep(WasntOpen, 1, 0), rep(WasntOpen, 2, 1)}
	verified := append(suspended, rep(HandVerified, 0, 2))
	if compute(verified...).SuspendedAt != nil {
		t.Error("verification did not lift")
	}
	one := compute(append(verified, rep(WasntOpen, 3, 3))...)
	if one.SuspendedAt != nil || score(one) < 0.7 {
		t.Errorf("one report after verification: %+v score %v", one, score(one))
	}
	if compute(rep(HandClosed, 0, 0)).SuspendedAt == nil {
		t.Error("hand closed did not suspend")
	}
	// A success afterwards from a visitor does not lift a suspension.
	if compute(rep(HandClosed, 0, 0), rep(ConfirmedOpen, 1, 1)).SuspendedAt == nil {
		t.Error("a visitor lifted a hand closure")
	}
}

func TestOneVisitCountsItsStrongestReport(t *testing.T) {
	in := Report{ID: "a", Kind: CheckedIn, UserID: 1, Visit: 7, At: day(0)}
	no := Report{ID: "b", Kind: WasntOpen, UserID: 1, Visit: 7, At: day(0)}
	for _, order := range [][]Report{{in, no}, {no, in}} {
		if r := Compute(order, nil, day(1)); r.Successes != 0 || r.Failures != 1 {
			t.Errorf("%+v", r)
		}
	}
	// Their later visit replaces the earlier one.
	later := Report{ID: "c", Kind: ConfirmedOpen, UserID: 1, Visit: 8, At: day(5)}
	if r := Compute([]Report{in, no, later}, nil, day(6)); r.Failures != 0 || r.Successes != 1 {
		t.Errorf("%+v", r)
	}
}

func TestOldReportsCountLess(t *testing.T) {
	r := compute(rep(WasntOpen, 1, 0), rep(CheckedIn, 2, 60))
	if math.Abs(r.Failures-0.5) > 1e-9 {
		t.Errorf("after one half-life: %v", r.Failures)
	}
	if got := Score(0, 1, day(0), day(60)); math.Abs(got-4.0/5.5) > 1e-9 {
		t.Errorf("score %v", got)
	}
	// Two wasn't-opens further apart than the window don't meet the two-reporter rule.
	if compute(rep(WasntOpen, 1, 0), rep(WasntOpen, 2, 61)).SuspendedAt != nil {
		t.Error("reports 61 days apart suspended")
	}
}

func TestSuspensionIsStickyAndOrderDoesNotMatter(t *testing.T) {
	reports := []Report{
		rep(CheckedIn, 1, 0), rep(WasntOpen, 2, 1), rep(SkippedClosed, 3, 2),
		rep(WasntOpen, 4, 3), rep(ConfirmedOpen, 5, 200),
	}
	want := Compute(reports, nil, day(300))
	if want.SuspendedAt == nil || !want.SuspendedAt.Equal(day(3)) {
		t.Fatalf("%+v", want)
	}
	for i := 0; i < 20; i++ {
		rand.Shuffle(len(reports), func(a, b int) { reports[a], reports[b] = reports[b], reports[a] })
		got := Compute(reports, nil, day(300))
		if got.Successes != want.Successes || got.Failures != want.Failures || !got.SuspendedAt.Equal(*want.SuspendedAt) {
			t.Fatalf("order changed the result: %+v vs %+v", got, want)
		}
	}
	// The evidence deleted: the suspension stays, until a verification after it.
	since := day(3)
	if Compute(nil, &since, day(10)).SuspendedAt == nil {
		t.Error("deletion lifted a suspension")
	}
	if Compute([]Report{rep(HandVerified, 0, 1)}, &since, day(10)).SuspendedAt == nil {
		t.Error("a verification from before the suspension lifted it")
	}
	if Compute([]Report{rep(HandVerified, 0, 5)}, &since, day(10)).SuspendedAt != nil {
		t.Error("a later verification did not lift")
	}
}
