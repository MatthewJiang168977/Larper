package hours

import (
	"encoding/json"
	"os"
	"testing"
)

// The API's curation page parses a strict subset of this syntax (apps/api/src/hours/parse.ts).
// Every input it accepts here must mean the same to ParseOSM.
func TestParseVectorsSharedWithTheAPI(t *testing.T) {
	b, err := os.ReadFile("testdata/parse-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Accepted []struct {
			Input    string   `json:"input"`
			Schedule Schedule `json:"schedule"`
		} `json:"accepted"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Accepted) == 0 {
		t.Fatal("no vectors")
	}
	for _, c := range v.Accepted {
		got, warns, err := ParseOSM(c.Input)
		if err != nil || got.Partial != PartialNone {
			t.Errorf("%q: err=%v partial=%v warnings=%v", c.Input, err, got.Partial, warns)
			continue
		}
		gj, _ := json.Marshal(got)
		wj, _ := json.Marshal(c.Schedule)
		if string(gj) != string(wj) {
			t.Errorf("%q:\n got %s\nwant %s", c.Input, gj, wj)
		}
	}
}
