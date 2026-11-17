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

// "Not today" is neutral: setting a quest aside, or saying it was too far, not today
// or closed, never moves taste. ("Not my thing" arrives as a SKIPPED event.)
func TestNotTodayIsNeutral(t *testing.T) {
	notToday := eventsv1.QuestAction_QUEST_ACTION_NOT_TODAY
	if _, moves := Step(notToday); moves {
		t.Fatalf("NOT_TODAY has a step")
	}
	if got := Update(user, place, notToday); &got[0] != &user[0] {
		t.Fatalf("NOT_TODAY changed taste")
	}
}

// "Not today" never counts as a dislike: an action with no step leaves the taste vector
// bit for bit as it was (the same values, not merely close ones), whatever the profile
// and the place. SKIPPED, the dislike, is the contrast: it does move it.
func TestActionsWithoutAStepLeaveTasteBitForBitUnchanged(t *testing.T) {
	old := []float32{0.6, 0.48, 0.64, 0, 0.1}
	place := []float32{0, 0.8, 0.6, 0.3, 0}
	before := append([]float32(nil), old...)

	for name, a := range map[string]eventsv1.QuestAction{
		"NOT_TODAY":   eventsv1.QuestAction_QUEST_ACTION_NOT_TODAY,
		"UNSPECIFIED": eventsv1.QuestAction_QUEST_ACTION_UNSPECIFIED,
		"unknown":     eventsv1.QuestAction(99),
	} {
		if _, moves := Step(a); moves {
			t.Fatalf("%s has a step", name)
		}
		got := Update(old, place, a)
		if len(got) != len(before) {
			t.Fatalf("%s: length changed: %v", name, got)
		}
		for i := range before {
			if math.Float32bits(got[i]) != math.Float32bits(before[i]) {
				t.Fatalf("%s moved taste at slot %d: %v -> %v", name, i, before[i], got[i])
			}
			if math.Float32bits(old[i]) != math.Float32bits(before[i]) {
				t.Fatalf("%s changed the caller's vector at slot %d", name, i)
			}
		}
		if got := Update(nil, place, a); got != nil {
			t.Fatalf("%s created a profile from nothing: %v", name, got)
		}
	}

	// The contrast: a SKIPPED event moves it.
	if _, moves := Step(skipped); !moves {
		t.Fatal("SKIPPED has no step")
	}
	moved := Update(old, place, skipped)
	same := true
	for i := range before {
		if math.Float32bits(moved[i]) != math.Float32bits(before[i]) {
			same = false
		}
	}
	if same {
		t.Fatal("SKIPPED left taste unchanged")
	}
}
