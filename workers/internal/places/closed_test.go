package places

import (
	"strings"
	"testing"
)

func TestClosedSuspect(t *testing.T) {
	const wiki = "http://en.wikipedia.org/wiki/index.html?curid=3505254"
	cases := []struct {
		name, website, category string
		flagged                 bool
	}{
		// The name says so, whatever else is true.
		{"Haru Sake Bar- CLOSED", "", "bar", true},
		{"16 Handles - Closed", "https://16handles.com", "casual_eatery", true},
		{"Rise Of Jack O Lanterns - New Jersey (closed)", "", "museum", true},
		{"Carvel - Temp Closed", "", "casual_eatery", true},
		{"Closedown Records", "", "books_music_and_video_store", false}, // a word, not "closed"
		{"Enclosed Garden Cafe", "", "cafe", false},
		// A Wikipedia entry in a business category: flagged.
		{"Academy of Music (New York City)", wiki, "music_venue", true},
		{"Roxy Theatre (New York City)", "https://en.wikipedia.org/wiki/Roxy_Theatre", "movie_theater", true},
		{"96th Street Subway Station", "https://en.m.wikipedia.org/wiki/96th_Street", "casual_eatery", true},
		{"Some Entry", "https://en.wikipedia.org/wiki/X", "", true}, // no category: not a landmark
		// The same in a landmark category: kept.
		{"Pomander Walk", "https://en.wikipedia.org/wiki/Pomander_Walk", "historic_site", false},
		{"Fort Wadsworth Lighthouse", "https://en.wikipedia.org/wiki/X", "lighthouse", false},
		{"Rockaway Beach", "https://en.wikipedia.org/wiki/X", "beach", false},
		// A real listing, or a page that only mentions Wikipedia: kept.
		{"Blue Note", "https://www.bluenotejazz.com", "music_venue", false},
		{"Wiki Bar", "https://wikipedia.org.example.com/menu", "bar", false},
		{"Wiki Bar", "https://notwikipedia.org/menu", "bar", false},
	}
	for _, c := range cases {
		got := closedSuspect(c.name, c.website, c.category)
		if (got != "") != c.flagged {
			t.Errorf("%q (%s, %q): got %q, want flagged=%v", c.name, c.category, c.website, got, c.flagged)
		}
		if got != "" && !strings.HasPrefix(got, "closed: ") {
			t.Errorf("%q: %q should start with 'closed: '", c.name, got)
		}
	}
}

// The real, open places from the review of the 59 Wikipedia entries in business
// categories (reported_places.txt).
var allowedOpen = map[string]string{
	"283936b9-b195-414e-9795-d5c6bd3faa4e": "Winter Garden Atrium",
	"7ae26441-666f-43da-a1d3-ec422e82ff01": "Battery Weed",
	"57e8d4ee-427e-44d1-8478-cfd8597564eb": "Fort Schuyler",
	"d25dd847-f99e-4a42-9a68-f27000697d21": "Belcher Ogden Mansion",
	"c455102e-497d-4e7e-b155-4c06ffa78829": "City Hall (New York City)",
	"dc2c7686-160e-4e4f-bbfe-1041614b9481": "Felix M. Warburg House",
	"ffa72dd7-496d-4aab-857a-ecf9a6083b15": "Fletcher-Sinclair Mansion",
	"340e61a7-f02c-47fc-aff4-e951238d1a6c": "John M. Mossman Lock Collection",
	"b457fab0-286c-46f5-b416-6a087227163e": "National Track and Field Hall of Fame",
	"87634b27-69a8-4a57-b516-7c8ebb51f85d": "Bay Plaza Shopping Center",
	"1ffe0c86-0157-4ea5-bba6-cfbee9a49175": "Wayne Towne Center",
	"e1c9b25b-28eb-42e5-8139-37dfc6bd206c": "Alamo by Bernard (Tony) Rosenthal",
	"cc13f3a1-9565-4e33-9de4-7a7e3d0d9100": "Al Hirschfeld Theatre",
	"ee4f1887-463f-4c8a-b423-95e92999b092": "Minskoff theatre",
	"7a1ca5f6-cd8e-410c-804e-e9237742ced3": "The Hayes Theater",
}

// The loader's whole decision for a row: allowed places pass the closure rules, reported
// ones are flagged whatever their name, and the rules apply to everything else.
func TestSuspectAppliesTheClosureReview(t *testing.T) {
	nyc := LocationCheck{PostcodePrefixes: NYCPostcodePrefixes}
	row := func(id, name, website, category string) overtureRow {
		pc := "10001"
		return overtureRow{OvertureID: id, Name: &name, Website: &website, BasicCategory: &category, Postcode: &pc}
	}
	const wiki = "https://en.wikipedia.org/wiki/X"
	for id, name := range allowedOpen {
		if got := suspect(nyc, row(id, name, wiki, "theatre_venue")); got != "" {
			t.Errorf("%s: flagged %q, want kept (allowed)", name, got)
		}
		if got := suspect(nyc, row("not-"+id, name, wiki, "theatre_venue")); got == "" {
			t.Errorf("%s: only the allowed id is kept", name)
		}
	}
	if got := suspect(nyc, row("d3af7b13-8477-4c8f-afa9-face950d64c6", "Blue Smoke And Jazz Standard", "https://www.bluesmoke.com", "sports_and_recreation")); !strings.HasPrefix(got, "reported: Blue Smoke") {
		t.Errorf("Blue Smoke And Jazz Standard: got %q", got)
	}
	if got := suspect(nyc, row("x", "Corner Cafe", "https://cornercafe.nyc", "cafe")); got != "" {
		t.Errorf("an ordinary place: got %q", got)
	}
	// The address rule still comes first.
	pc := "33401"
	r := row("x", "Haru Sake Bar- CLOSED", "", "bar")
	r.Postcode = &pc
	if got := suspect(nyc, r); got != "postcode 33401 is outside the region" {
		t.Errorf("address first: got %q", got)
	}
	for id, name := range allowedOpen {
		if allowed[id] == "" {
			t.Errorf("%s (%s) isn't allowed in reported_places.txt", name, id)
		}
	}
}
