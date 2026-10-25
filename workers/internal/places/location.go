package places

import (
	_ "embed"
	"regexp"
	"strings"
	"unicode"
)

// Some Overture records put a place's point inside our region while its own address
// says it's somewhere else: a business page that lists only "New York" as its city gets
// a point in Manhattan, wherever the place really is. On 2026-10-24 the Union Square
// deck offered "VerKeerderkill Falls, Sams Point Preserve" (the Catskills, ~140 km away)
// as a lead: Overture has it at 40.7335, -73.9817 with the address "New York, NY". The
// deck's distance filter was right; the point was wrong.
//
// Coordinates can't show this, so the loader reads the address and flags a place whose
// postcode contradicts the region. A flagged place keeps its row (users' quests point at
// it) but never reaches a deck or the area stats (places.location_suspect, migration
// 0015). Measured on the 80,001 NYC places and reviewed by hand: the rule flags 116,
// all really elsewhere (Thai and Korean shops, Florida and upstate businesses, Catskill
// parks) except 8 real NYC places with a garbage postcode, which reported_places.txt
// allows; 108 stay flagged.

// LocationCheck holds what a region's addresses look like. The zero value checks only
// the reported list: a deployment without postcode prefixes (local development, or a
// metro not set up yet) flags nothing by address, rather than everything.
type LocationCheck struct {
	// PostcodePrefixes: the first digits of every US ZIP code inside the region. Set,
	// a place whose postcode is a US ZIP outside them, or not a US ZIP at all, is flagged.
	PostcodePrefixes []string
}

var (
	phoneShaped = regexp.MustCompile(`^\d{3}-\d{3}-\d{4}$`)
	zipMissing0 = regexp.MustCompile(`^\d{4}(-\d{4})?$`) // a NJ ZIP that lost its leading 0
	zipNoDash   = regexp.MustCompile(`^\d{9}$`)          // ZIP+4 written without the dash
	zip5        = regexp.MustCompile(`(?:^|\D)(\d{5})(?:\D|$)`)
)

//go:embed reported_places.txt
var reportedFile string

// The hand-reviewed overrides in reported_places.txt: places reported as mislocated
// that no address rule catches (no postcode at all), and places really here whose
// postcode says otherwise ("allow"). Each maps an Overture id to its note.
var reported, allowed = parseOverrides(reportedFile)

func parseOverrides(s string) (reported, allowed map[string]string) {
	reported, allowed = map[string]string{}, map[string]string{}
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		into := reported
		if rest, ok := strings.CutPrefix(line, "allow "); ok {
			into, line = allowed, strings.TrimSpace(rest)
		}
		id, note, _ := strings.Cut(line, " ")
		into[id] = strings.TrimSpace(note)
	}
	return reported, allowed
}

// zipOf returns the US ZIP in a postcode, "" if it holds none, and whether the value
// should be read as a postcode at all (phone numbers and "USA" aren't).
func zipOf(postcode string) (zip string, isPostcode bool) {
	pc := strings.TrimSpace(postcode)
	switch {
	case pc == "" || strings.EqualFold(pc, "USA") || phoneShaped.MatchString(pc):
		return "", false
	case zipMissing0.MatchString(pc):
		return "0" + pc[:4], true
	case zipNoDash.MatchString(pc):
		return pc[:5], true
	}
	if m := zip5.FindStringSubmatch(pc); m != nil {
		return m[1], true
	}
	return "", true
}

func nonLatin(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) && !unicode.Is(unicode.Latin, r) {
			return true
		}
	}
	return false
}

// Suspect returns why a place's point can't be trusted, or "" if nothing says so.
func (c LocationCheck) Suspect(overtureID, postcode, street string) string {
	if note, ok := reported[overtureID]; ok {
		return "reported: " + note
	}
	if _, ok := allowed[overtureID]; ok || len(c.PostcodePrefixes) == 0 {
		return ""
	}
	zip, isPostcode := zipOf(postcode)
	if !isPostcode {
		return ""
	}
	if zip != "" {
		for _, p := range c.PostcodePrefixes {
			if strings.HasPrefix(zip, p) {
				return ""
			}
		}
		return "postcode " + zip + " is outside the region"
	}
	// Not a US ZIP. "<<not-applicable>>" with a Latin street is too often a real local
	// place (a Queens street, say) to flag on its own; a foreign postcode, or a street in
	// another script, says the address is abroad.
	if strings.Contains(postcode, "not-applicable") && !nonLatin(street) {
		return ""
	}
	return "postcode isn't a US ZIP (" + strings.TrimSpace(postcode) + ")"
}

// NYCPostcodePrefixes: the US ZIP prefixes inside the NYC region box
// (-74.26,40.49,-73.70,40.92; data/extract_overture.py, Helm api.ingestRegion):
// Manhattan, the Bronx, Staten Island and Westchester's edge (100-108), Queens,
// Brooklyn and Nassau's edge (110-116), North Jersey (070-076) and the Woodbridge area
// the box's west edge reaches (088).
var NYCPostcodePrefixes = []string{
	"070", "071", "072", "073", "074", "075", "076", "088",
	"100", "101", "102", "103", "104", "105", "106", "107", "108",
	"110", "111", "112", "113", "114", "115", "116",
}

// ParsePrefixes reads "nyc" (NYCPostcodePrefixes), a comma-separated list, or "" (none).
func ParsePrefixes(s string) []string {
	s = strings.TrimSpace(s)
	if strings.EqualFold(s, "nyc") {
		return NYCPostcodePrefixes
	}
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
