package hours

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
	"time"
)

// vectors.json is shared with the TypeScript API tests, which copy it verbatim. These
// tests run every vector, so the file is proven against this implementation.
type vectorFile struct {
	V     int `json:"v"`
	State []struct {
		Name     string    `json:"name"`
		Schedule *Schedule `json:"schedule"`
		At       string    `json:"at"`
		Expect   State     `json:"expect"`
	} `json:"state"`
	Parse []struct {
		Name     string          `json:"name"`
		Syntax   string          `json:"syntax"`
		Input    json.RawMessage `json:"input"`
		Schedule *Schedule       `json:"schedule"`
		Error    bool            `json:"error"`
	} `json:"parse"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectorFile
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&v); err != nil {
		t.Fatal(err)
	}
	if v.V != 1 {
		t.Fatalf("vectors version %d", v.V)
	}
	return v
}

func TestVectorCounts(t *testing.T) {
	v := loadVectors(t)
	if len(v.State) < 60 || len(v.Parse) < 40 {
		t.Fatalf("%d state and %d parse vectors, want at least 60 and 40", len(v.State), len(v.Parse))
	}
}

// Schedules in the file are written in canonical form: valid as they stand, and equal
// to their own normalization.
func TestVectorSchedulesAreCanonical(t *testing.T) {
	v := loadVectors(t)
	check := func(name string, s *Schedule) {
		if s == nil {
			return
		}
		if err := s.Validate(); err != nil {
			t.Errorf("%s: %v", name, err)
		}
		before, _ := json.Marshal(s)
		n := *s
		n.Normalize()
		after, _ := json.Marshal(n)
		if !bytes.Equal(before, after) {
			t.Errorf("%s: not canonical:\n%s\n%s", name, before, after)
		}
	}
	for _, c := range v.State {
		check(c.Name, c.Schedule)
	}
	for _, c := range v.Parse {
		check(c.Name, c.Schedule)
	}
}

func TestStateVectors(t *testing.T) {
	for _, c := range loadVectors(t).State {
		at, err := time.Parse(time.RFC3339, c.At)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if got := StateAt(c.Schedule, at); got != c.Expect {
			t.Errorf("%s: StateAt(%s) = %s, want %s", c.Name, c.At, got, c.Expect)
		}
	}
}

func TestParseVectors(t *testing.T) {
	for _, c := range loadVectors(t).Parse {
		var (
			got Schedule
			err error
		)
		switch c.Syntax {
		case "osm":
			var in string
			if e := json.Unmarshal(c.Input, &in); e != nil {
				t.Fatalf("%s: osm input must be a string: %v", c.Name, e)
			}
			got, _, err = ParseOSM(in)
		case "schema.org":
			got, _, err = ParseSchemaOrg(c.Input)
		default:
			t.Fatalf("%s: syntax %q", c.Name, c.Syntax)
		}
		if c.Error {
			if err == nil {
				t.Errorf("%s: want an error, got %s", c.Name, mustJSON(got))
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.Name, err)
			continue
		}
		if g, w := mustJSON(got), mustJSON(c.Schedule); g != w {
			t.Errorf("%s:\n got  %s\n want %s", c.Name, g, w)
		}
	}
}
