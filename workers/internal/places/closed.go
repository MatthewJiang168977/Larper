package places

import (
	"regexp"
	"strings"
)

// The loader only keeps places Overture calls open, yet some are long gone. On
// 2026-10-25 a demo deck offered "Academy of Music (New York City)", demolished in 1926,
// and "Blue Smoke And Jazz Standard", closed in 2020 (Overture's own Jazz Standard record
// is marked closed; a business registry's duplicate still says open, confidence 0.99).
// Confidence doesn't tell them apart, so two narrow rules do, measured on the 80,001 NYC
// places (Overture 2026-09-23.1) and reviewed by hand:
//
//   - The name says so: "Haru Sake Bar- CLOSED", "16 Handles - Closed". 5 places.
//   - The place is a Wikipedia article, not a listing (its website is a wikipedia.org
//     page), in a category you'd visit as a business: a venue, club, theatre, shop,
//     restaurant, museum. 59 places. These are encyclopedia entries, and many describe
//     something that no longer exists (the Roxy, the Limelight, the Mudd Club) or that
//     isn't what the category says (subway stations as eateries). The ones that are real
//     and open (Broadway theatres, house museums) are allowed in reported_places.txt.
//     The same entries in a landmark category (a historic building, a park, a monument;
//     217 places) mostly still stand, so those are kept.
//
// A flagged place goes into places.location_suspect like a mislocated one: it keeps its
// row but never reaches a deck or the area stats.

var closedInName = regexp.MustCompile(`(?i)\bclosed\b`)

// Categories (Overture basic_category) where a Wikipedia entry is a thing to go and
// look at, whatever became of the business, if any.
var landmarkCategories = map[string]bool{
	"historic_site": true, "landmark_and_historical_building": true, "monument": true,
	"memorial_site": true, "sculpture_statue": true, "lighthouse": true, "bridge": true,
	"park": true, "beach": true, "garden": true, "trail": true, "playground": true,
	"plaza": true, "public_plaza": true, "street": true, "neighborhood": true,
	"island": true, "cemetery": true, "natural_feature": true, "structure_and_geography": true,
}

// closedSuspect returns why a place is probably not there to visit any more, or "".
func closedSuspect(name, website, basicCategory string) string {
	if closedInName.MatchString(name) {
		return "closed: the name says so"
	}
	if isWikipedia(website) && !landmarkCategories[basicCategory] {
		return "closed: a Wikipedia entry, not a listing (" + orNone(basicCategory) + ")"
	}
	return ""
}

func isWikipedia(website string) bool {
	host := strings.ToLower(website)
	host, _ = strings.CutPrefix(host, "https://")
	host, _ = strings.CutPrefix(host, "http://")
	host, _, _ = strings.Cut(host, "/")
	return host == "wikipedia.org" || strings.HasSuffix(host, ".wikipedia.org")
}

func orNone(s string) string {
	if s == "" {
		return "no category"
	}
	return s
}
