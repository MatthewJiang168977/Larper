package places

import (
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
