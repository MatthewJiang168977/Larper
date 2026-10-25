package places

import (
	"regexp"
	"strings"
	"testing"
)

// Cases from the 2026-10-24 review of the 80,001 NYC places (name, postcode, street as
// Overture has them).
func TestLocationSuspect(t *testing.T) {
	nyc := LocationCheck{PostcodePrefixes: NYCPostcodePrefixes}
	cases := []struct {
		name, id, postcode, street string
		flagged                    bool
	}{
		// Elsewhere: flagged.
		{"Catskill Forest Preserve (Airmont)", "x", "10952-3522", "18 New County Rd", true},
		{"Charleys Cheesesteaks (Middletown)", "x", "10941", "1 N Galleria Dr Ste FC05", true},
		{"Sushi By Bou (West Palm Beach)", "x", "33401-6616", "710 N St", true},
		{"Kent Falls State Park (CT)", "x", "06754", "462 Kent Cornwall Rd", true},
		{"GameStop (Manalapan NJ, 077: outside the box)", "x", "07726", "Union 22 Plz", true},
		{"Thai cafe", "x", "82210", "ถนนเพชรเกษม 5/37", true},
		{"Japanese restaurant", "x", "〒314-0031", "宮中6-2-4", true},
		{"Korean cafe, postcode in Hangul", "x", "난설헌로219", "강원도강릉시", true},
		{"UK pub", "x", "HX78EX", "Bridge Gate", true},
		{"Taiwanese bakery, n/a postcode, street in Han", "x", "<<not-applicable>>", "敦化北路4巷39號", true},
		// Here: kept.
		{"Manhattan ZIP", "x", "10003", "123 Main St", false},
		{"ZIP+4 in the box", "x", "11201-1234", "1 Court St", false},
		{"'NY 10012' format", "x", "NY 10012", "237 Elizabeth St", false},
		{"Hoboken ZIP missing its 0 (7030)", "x", "7030", "Castle Point on Hudson", false},
		{"Brooklyn ZIP+4 with no dash", "x", "112392801", "505 Gateway Dr", false},
		{"Woodbridge NJ (088, inside the box's west edge)", "x", "08830", "1 Main St", false},
		{"Nassau (115)", "x", "11581-1907", "429 Rockaway Ave", false},
		{"phone number in the postcode field (JFK)", "x", "718-751-4765", "Terminal 4", false},
		{"'USA' as the postcode", "x", "USA", "2955 Veterans Rd W", false},
		{"n/a postcode, Queens street", "x", "<<not-applicable>>", "Farmers Blvd", false},
		{"no postcode at all (parks, landmarks)", "x", "", "", false},
		// The reported list catches what addresses can't.
		{"VerKeerderkill Falls (no postcode)", "58475f4b-e8ba-4aae-b246-1efa5e33f6b5", "", "", true},
	}
	for _, c := range cases {
		got := nyc.Suspect(c.id, c.postcode, c.street)
		if (got != "") != c.flagged {
			t.Errorf("%s: Suspect = %q, want flagged=%v", c.name, got, c.flagged)
		}
	}
}

func TestLocationSuspectReasons(t *testing.T) {
	nyc := LocationCheck{PostcodePrefixes: NYCPostcodePrefixes}
	if got := nyc.Suspect("x", "10952-3522", ""); got != "postcode 10952 is outside the region" {
		t.Errorf("got %q", got)
	}
	if got := nyc.Suspect("58475f4b-e8ba-4aae-b246-1efa5e33f6b5", "", ""); !strings.HasPrefix(got, "reported: VerKeerderkill Falls") {
		t.Errorf("got %q", got)
	}
}

func TestLocationSuspectWithoutPrefixesChecksOnlyTheReportedList(t *testing.T) {
	var none LocationCheck // local development, or a metro not set up yet
	if got := none.Suspect("x", "33401", "710 N St"); got != "" {
		t.Errorf("flagged by address with no prefixes configured: %q", got)
	}
	if got := none.Suspect("x", "HX78EX", "Bridge Gate"); got != "" {
		t.Errorf("flagged a foreign postcode with no prefixes configured: %q", got)
	}
	if got := none.Suspect("58475f4b-e8ba-4aae-b246-1efa5e33f6b5", "", ""); got == "" {
		t.Error("the reported list must apply everywhere")
	}
}

func TestParsePrefixes(t *testing.T) {
	if got := ParsePrefixes("nyc"); len(got) != len(NYCPostcodePrefixes) {
		t.Errorf("nyc: %v", got)
	}
	if got := ParsePrefixes(" 606, 607 ,"); strings.Join(got, "|") != "606|607" {
		t.Errorf("list: %v", got)
	}
	if got := ParsePrefixes(""); got != nil {
		t.Errorf("empty: %v", got)
	}
}

// The 8 real NYC places from the review whose postcode is garbage stay in decks.
func TestLocationSuspectAllowsReviewedPlaces(t *testing.T) {
	nyc := LocationCheck{PostcodePrefixes: NYCPostcodePrefixes}
	cases := map[string]string{ // id -> its (garbage) postcode
		"b8d17c91-6a77-4bd4-a490-d3a2c9b47bd6": "14058",      // Arthur Avenue
		"3141985e-3f78-48a5-941a-b606d3732bf5": "13456",      // Hudson River Park Playground
		"3ab4ad19-baeb-42bd-980b-7c1a0a73ac4b": "13440",      // Pier 51
		"a008806c-72fd-41e2-a6c1-8a45fda2e5e4": "12018",      // Mercer-Houston Dog Run
		"424a1ee6-1eaa-4ff4-a81a-0f4ce7a4f469": "00754",      // Orchard Beach
		"cc1addc9-214f-4150-b8eb-95a943a82ffc": "12004",      // Kiss Art Gallery
		"0fad8712-2726-430f-a258-9ec8298487db": "11803-6428", // Liberty State Park pavilion
		"eb5d43a8-0ea0-4d8d-bf1d-faba1b1b5168": "07719-2142", // Yankee Stadium parking lot
	}
	for id, pc := range cases {
		if got := nyc.Suspect(id, pc, ""); got != "" {
			t.Errorf("%s (%s): flagged %q, want kept", id, pc, got)
		}
		if got := nyc.Suspect("not-"+id, pc, ""); got == "" {
			t.Errorf("postcode %s alone should be flagged; only the allowed id is kept", pc)
		}
	}
	if len(allowed) != len(cases) {
		t.Errorf("allowed has %d ids, want %d", len(allowed), len(cases))
	}
}

func TestOverridesFileIsWellFormed(t *testing.T) {
	uuid := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	for kind, m := range map[string]map[string]string{"reported": reported, "allowed": allowed} {
		for id, note := range m {
			if !uuid.MatchString(id) {
				t.Errorf("%s: %q isn't an Overture id", kind, id)
			}
			if note == "" {
				t.Errorf("%s: %s has no note", kind, id)
			}
			if _, both := reported[id]; both && kind == "allowed" {
				t.Errorf("%s is both reported and allowed", id)
			}
		}
	}
	if len(reported) == 0 || len(allowed) == 0 {
		t.Error("expected both reported and allowed entries")
	}
}
