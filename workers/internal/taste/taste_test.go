package taste

import (
	"math"
	"testing"

	eventsv1 "github.com/MatthewJiang168977/larper/workers/gen/larper/events/v1"
)

const (
	accepted  = eventsv1.QuestAction_QUEST_ACTION_ACCEPTED
	completed = eventsv1.QuestAction_QUEST_ACTION_COMPLETED
	skipped   = eventsv1.QuestAction_QUEST_ACTION_SKIPPED
)

func norm(v []float32) float64 {
	var s float64
	for _, x := range v {
		s += float64(x) * float64(x)
	}
	return math.Sqrt(s)
}

func cos(a, b []float32) float64 {
	var d float64
	for i := range a {
		d += float64(a[i]) * float64(b[i])
	}
	return d / (norm(a) * norm(b))
}

var (
	user  = []float32{1, 0, 0}
	place = []float32{0, 1, 0}
)

func TestUpdateStaysUnitLength(t *testing.T) {
	for _, a := range []eventsv1.QuestAction{accepted, completed, skipped} {
		if n := norm(Update(user, place, a)); math.Abs(n-1) > 1e-6 {
			t.Errorf("%v: |v| = %v", a, n)
		}
	}
}

func TestCompletingMovesTowardThePlaceMoreThanAccepting(t *testing.T) {
	acc := cos(Update(user, place, accepted), place)
	done := cos(Update(user, place, completed), place)
	if !(done > acc && acc > cos(user, place)) {
		t.Fatalf("similarity to place: start %.3f accepted %.3f completed %.3f", cos(user, place), acc, done)
	}
}

func TestSkippingMovesAway(t *testing.T) {
	near := []float32{0.6, 0.8, 0}
	if after := Update(near, place, skipped); cos(after, place) >= cos(near, place) {
		t.Fatalf("skip did not move away: %.3f -> %.3f", cos(near, place), cos(after, place))
	}
}

func TestOldTasteDecaysButSurvivesOneEvent(t *testing.T) {
	after := Update(user, place, completed)
	if after[0] <= after[1] {
		t.Fatalf("one visit overwrote the profile: %v", after)
	}
}

func TestNoProfile(t *testing.T) {
	if got := Update(nil, place, completed); cos(got, place) < 0.999 {
		t.Fatalf("first visit should seed taste from the place, got %v", got)
	}
	if got := Update(nil, place, skipped); got != nil {
		t.Fatalf("skip with no profile should store nothing, got %v", got)
	}
}

func TestUnknownActionIsNoop(t *testing.T) {
	if got := Update(user, place, eventsv1.QuestAction(99)); &got[0] != &user[0] {
		t.Fatalf("unknown action changed taste")
	}
}
