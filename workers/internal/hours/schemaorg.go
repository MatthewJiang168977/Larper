package hours

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"
)

// MaxSchemaOrgLen bounds the JSON ParseSchemaOrg accepts.
const MaxSchemaOrgLen = 256 << 10

// ParseSchemaOrg parses schema.org opening hours. raw is JSON (or plain text for the
// text form) and may be any of:
//
//   - a string or an array of strings in the openingHours text form: "Mo-Fr 09:00-17:00",
//     "Mo,Tu,We 09:00-17:00", "Mo-Fr 09:00-12:00,13:00-17:00", "Fr 22:00-02:00". A day
//     selector with no times ("Mo-Su") means all day. Several groups may share a string
//     ("Mo-Fr 09:00-17:00 Sa 10:00-14:00"). Every string and group ADDS to the others;
//     there is no override order as in OSM.
//   - an OpeningHoursSpecification object, or an array of them: dayOfWeek is "Monday",
//     "https://schema.org/Monday" or an array of those (also PublicHolidays); opens and
//     closes are "09:00" or "09:00:00".
//   - a whole place object with openingHours and/or openingHoursSpecification keys.
//
// Reading of specifications:
//
//   - closes before opens (or "00:00" with opens later in the day) closes the next
//     morning or at midnight: opens 22:00 closes 02:00 is 22:00-26:00; opens 09:00
//     closes 00:00 is 09:00-24:00.
//   - closes 23:59 (or 23:59:xx) is read as 24:00. It is Google's way to say "open all
//     day" and nobody means to close for the last minute.
//   - opens = closes = "00:00" means closed all day, the Google convention (opens 00:00
//     closes 23:59 is how Google says 24 hours). Any other opens = closes can't be read
//     and the specification is dropped.
//   - validFrom and validThrough on the same single day make a dates override for that
//     day ("YYYY-MM-DD", closed or with spans). Any other validity (a range, one bound)
//     can't be stored: the specification is dropped and the schedule is restrictive.
//   - dayOfWeek PublicHolidays with opens = closes = "00:00" sets holidays "closed";
//     with other times holidays stays null (holiday hours can't be stored).
//
// What can't be read is dropped with a warning and makes the schedule restrictive. When
// no open span was read the error is ErrNoHours.
func ParseSchemaOrg(raw json.RawMessage) (Schedule, []Warning, error) {
	if len(raw) > MaxSchemaOrgLen {
		return Schedule{}, nil, ErrTooLong
	}
	b := newBuilder()
	b.value(bytes.TrimSpace(raw), 0)
	s, err := b.finish()
	return s, b.warns, err
}

// value reads one JSON value: a string, an array, or an object.
func (b *builder) value(raw []byte, depth int) {
	if len(raw) == 0 || string(raw) == "null" {
		return
	}
	if depth > 3 {
		b.warn("unsupported", "nesting too deep")
		b.setPartial(PartialRestrictive)
		return
	}
	switch raw[0] {
	case '"':
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			b.warn("unsupported", "bad string: %v", err)
			b.setPartial(PartialRestrictive)
			return
		}
		b.text(s)
	case '[':
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			b.warn("unsupported", "bad array: %v", err)
			b.setPartial(PartialRestrictive)
			return
		}
		for _, it := range items {
			b.value(bytes.TrimSpace(it), depth+1)
		}
	case '{':
		b.object(raw, depth)
	default:
		if utf8.Valid(raw) && raw[0] != '-' && !(raw[0] >= '0' && raw[0] <= '9') {
			b.text(string(raw)) // plain text, not JSON
			return
		}
		b.warn("unsupported", "not a string, array or object")
		b.setPartial(PartialRestrictive)
	}
}

func (b *builder) object(raw []byte, depth int) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		b.warn("unsupported", "bad object: %v", err)
		b.setPartial(PartialRestrictive)
		return
	}
	_, hasText := m["openingHours"]
	_, hasSpecs := m["openingHoursSpecification"]
	switch {
	case hasText || hasSpecs:
		b.value(bytes.TrimSpace(m["openingHours"]), depth+1)
		b.value(bytes.TrimSpace(m["openingHoursSpecification"]), depth+1)
	case m["dayOfWeek"] != nil || m["opens"] != nil || m["closes"] != nil || m["validFrom"] != nil:
		b.spec(raw)
	default:
		b.warn("unsupported", "object without opening hours")
		b.setPartial(PartialRestrictive)
	}
}

// text reads one openingHours string: groups of weekdays and optional times.
func (b *builder) text(s string) {
	if len(s) > MaxInputLen {
		b.warn("unsupported", "text too long")
		b.setPartial(PartialRestrictive)
		return
	}
	toks := tokenize(normalizeText(s))
	for _, t := range toks {
		if isWord(t, "am") || isWord(t, "pm") {
			b.warn("unsupported", "%q: 12-hour times", s)
			b.setPartial(PartialRestrictive)
			return
		}
	}
	p := &parser{toks: toks}
	for p.peek().kind != tkEOF {
		if isSym(p.peek(), ";") || isSym(p.peek(), ",") {
			p.i++
			continue
		}
		r := rule{allDays: true}
		p.weekdays(&r)
		if r.unsupported == "" && r.allDays {
			r.fail("no weekday")
		}
		if r.unsupported == "" {
			p.times(&r)
		}
		switch {
		case r.unsupported != "":
		case r.off || r.unknown || r.open || r.variable || r.openEnded || r.comment || r.all247:
			r.fail("unsupported time")
		}
		if r.unsupported != "" {
			b.warn("unsupported", "%q: %s", s, r.unsupported)
			b.setPartial(PartialRestrictive)
			return
		}
		if len(r.spans) == 0 {
			r.spans = []Span{{0, 1440}}
		}
		b.addWeekly(r.days, r.ph, r.spans, false)
	}
}

// addWeekly adds spans to the weekdays in days; holiday spans can only close.
func (b *builder) addWeekly(days [8]bool, ph bool, spans []Span, closedAllDay bool) {
	for d := 1; d <= 7; d++ {
		if days[d] {
			b.days[d] = append(b.days[d], spans...)
		}
	}
	if ph {
		if closedAllDay {
			b.setHolidays(HolidaysClosed)
		} else {
			b.warn("holiday_hours", "holiday hours can't be stored; holidays stays unstated")
		}
	}
}

type specJSON struct {
	DayOfWeek    json.RawMessage `json:"dayOfWeek"`
	Opens        json.RawMessage `json:"opens"`
	Closes       json.RawMessage `json:"closes"`
	ValidFrom    json.RawMessage `json:"validFrom"`
	ValidThrough json.RawMessage `json:"validThrough"`
}

func jsonString(raw json.RawMessage) (string, bool) {
	var s string
	if len(raw) == 0 || json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	return s, true
}

var schemaDays = map[string]int{
	"monday": 1, "tuesday": 2, "wednesday": 3, "thursday": 4,
	"friday": 5, "saturday": 6, "sunday": 7,
}

// spec reads one OpeningHoursSpecification.
func (b *builder) spec(raw []byte) {
	drop := func(why string) {
		b.warn("unsupported", "openingHoursSpecification: %s", why)
		b.setPartial(PartialRestrictive)
	}
	var sp specJSON
	if err := json.Unmarshal(raw, &sp); err != nil {
		drop("bad object")
		return
	}
	var days [8]bool
	ph, anyDay := false, false
	if len(sp.DayOfWeek) > 0 && string(sp.DayOfWeek) != "null" {
		var names []string
		if s, ok := jsonString(sp.DayOfWeek); ok {
			names = []string{s}
		} else if err := json.Unmarshal(sp.DayOfWeek, &names); err != nil {
			drop("bad dayOfWeek")
			return
		}
		for _, n := range names {
			if i := strings.LastIndexAny(n, "/:"); i >= 0 {
				n = n[i+1:]
			}
			n = strings.ToLower(strings.TrimSpace(n))
			switch {
			case schemaDays[n] > 0:
				days[schemaDays[n]], anyDay = true, true
			case n == "publicholidays":
				ph, anyDay = true, true
			default:
				drop("unknown day " + n)
				return
			}
		}
	}
	opensS, ok1 := jsonString(sp.Opens)
	closesS, ok2 := jsonString(sp.Closes)
	opens, ok3 := parseClock(opensS)
	closes, ok4 := parseClock(closesS)
	if !ok1 || !ok2 || !ok3 || !ok4 || opens >= 1440 {
		drop("opens and closes must both be HH:MM times")
		return
	}
	closedAllDay := opens == 0 && closes == 0
	var spans []Span
	if !closedAllDay {
		to := closes
		switch {
		case closes == opens:
			drop("opens equals closes")
			return
		case closes == 1439:
			to = 1440
		case closes < opens:
			to = closes + 1440
		case closes == 0:
			to = 1440
		}
		spans = []Span{{opens, to}}
	}

	hasFrom, hasThrough := len(sp.ValidFrom) > 0 && string(sp.ValidFrom) != "null", len(sp.ValidThrough) > 0 && string(sp.ValidThrough) != "null"
	if hasFrom || hasThrough {
		from, okF := jsonString(sp.ValidFrom)
		through, okT := jsonString(sp.ValidThrough)
		day, okD := dayOf(from)
		dayT, okDT := dayOf(through)
		if !(hasFrom && hasThrough && okF && okT && okD && okDT && day == dayT) {
			drop("validFrom/validThrough that isn't a single day")
			return
		}
		t, _ := time.Parse("2006-01-02", day)
		if anyDay && !days[(int(t.Weekday())+6)%7+1] && !ph {
			b.warn("unsupported", "openingHoursSpecification for %s doesn't include that weekday; skipped", day)
			return
		}
		dr := b.dateRule(day)
		switch {
		case closedAllDay && len(dr.Spans) == 0:
			dr.Closed = true
		case !closedAllDay:
			dr.Closed = false
			dr.Spans = append(dr.Spans, spans...)
		}
		return
	}
	if !anyDay {
		drop("no dayOfWeek")
		return
	}
	b.addWeekly(days, ph, spans, closedAllDay)
}

// dayOf returns the "YYYY-MM-DD" at the start of a schema.org Date or DateTime.
func dayOf(s string) (string, bool) {
	if len(s) < 10 {
		return "", false
	}
	if _, err := time.Parse("2006-01-02", s[:10]); err != nil {
		return "", false
	}
	return s[:10], true
}

// parseClock reads "9:00", "09:00" and "09:00:00" as minutes after midnight; "24:00"
// is 1440. Seconds are ignored.
func parseClock(s string) (int, bool) {
	parts := strings.Split(strings.TrimSpace(s), ":")
	if len(parts) < 2 || len(parts) > 3 {
		return 0, false
	}
	nums := make([]int, len(parts))
	for i, p := range parts {
		if len(p) < 1 || len(p) > 2 {
			return 0, false
		}
		n := 0
		for _, c := range []byte(p) {
			if !isDigit(c) {
				return 0, false
			}
			n = n*10 + int(c-'0')
		}
		nums[i] = n
	}
	h, m := nums[0], nums[1]
	if m > 59 || h > 24 || h == 24 && m > 0 || len(parts) == 3 && nums[2] > 59 {
		return 0, false
	}
	return h*60 + m, true
}
