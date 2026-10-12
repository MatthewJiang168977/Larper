// Package taste updates a user's taste vector from what they do with quests.
package taste

import (
	"math"

	eventsv1 "github.com/MatthewJiang168977/larper/workers/gen/larper/events/v1"
)

// Step sizes per action. An exponentially weighted moving average:
//
//	new = normalize((1 - |b|) * old + b * place)
//
// Going somewhere (completed) moves taste most; accepting moves it a bit; skipping
// nudges away. Old evidence decays geometrically instead of being erased, so one
// odd evening doesn't rewrite the profile.
var steps = map[eventsv1.QuestAction]float64{
	eventsv1.QuestAction_QUEST_ACTION_ACCEPTED:  0.10,
	eventsv1.QuestAction_QUEST_ACTION_COMPLETED: 0.20,
	eventsv1.QuestAction_QUEST_ACTION_SKIPPED:   -0.05,
}

// Step returns the step size for an action and whether the action moves taste at all.
func Step(a eventsv1.QuestAction) (float64, bool) {
	b, ok := steps[a]
	return b, ok
}

// Update applies one action. old may be nil (no profile yet). It returns nil when
// there's nothing meaningful to store: e.g. a skip with no profile to move away from.
func Update(old, place []float32, a eventsv1.QuestAction) []float32 {
	b, ok := steps[a]
	if !ok || len(place) == 0 {
		return old
	}
	if old == nil {
		if b <= 0 {
			return nil
		}
		old = make([]float32, len(place))
	}
	out := make([]float32, len(place))
	keep := 1 - math.Abs(b)
	var norm float64
	for i := range out {
		v := keep*float64(old[i]) + b*float64(place[i])
		out[i] = float32(v)
		norm += v * v
	}
	if norm == 0 {
		return old
	}
	norm = math.Sqrt(norm)
	for i := range out {
		out[i] = float32(float64(out[i]) / norm)
	}
	return out
}
