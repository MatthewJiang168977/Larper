package hours

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// MaxInputLen bounds what the parsers accept; longer input is ErrTooLong. Real
// opening_hours values are a few hundred bytes at most.
const MaxInputLen = 1024

var (
	// ErrNoHours means nothing usable was parsed. The caller stores no schedule: hours
	// are unknown, which is not the same as closed.
	ErrNoHours = errors.New("hours: no usable opening hours")
	// ErrTooLong means the input is over MaxInputLen.
	ErrTooLong = errors.New("hours: input too long")
	// ErrTwelveHour means a 12-hour time (9am, 5:00 PM); neither syntax allows them.
	ErrTwelveHour = errors.New("hours: 12-hour times are not valid")
)

// Warning says what the parser dropped or didn't trust. Codes:
//
//	unsupported   a rule uses a construct we don't evaluate (month or week ranges, year
//	              ranges, nth weekday, school holidays, ...) and was dropped; partial restrictive
//	fallback      a "||" fallback rule was dropped; restrictive
//	unknown_state a rule says "unknown" (or only a comment) and was dropped; restrictive
//	comment       a comment sits on a rule that has opening times; the rule is kept; restrictive
//	removed_time  "off" with times (a hole in earlier hours) was dropped; restrictive
//	additive_off  "off" as an additional (",") rule on weekdays was dropped; restrictive
//	open_ended    "17:00+" has no closing time, so that part was dropped; additive
//	variable_time sunrise/sunset/dawn/dusk times were dropped; additive
//	holiday_hours public holidays have their own hours, which can't be stored; holidays stays null
//	override      a later rule overrides an earlier one (informational)
type Warning struct {
	Code    string
	Message string
}

func (w Warning) String() string { return w.Code + ": " + w.Message }

// ---- tokens ----

type tokKind int

const (
	tkEOF     tokKind = iota
	tkWord            // lower-case letters
	tkNum             // 1-4 digits
	tkTime            // 9:00, 09.00; n is minutes
	tk247             // 24/7
	tkSym             // - , ; : + [ ] ( ) ||
	tkComment         // "text"
	tkBad             // anything else
)

type token struct {
	kind tokKind
	s    string
	n    int
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func isLetter(c byte) bool { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }

// tokenize never fails: whatever it can't read becomes a tkBad token that makes its
// rule unsupported. s has been through normalizeText.
func tokenize(s string) []token {
	var toks []token
	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '"':
			end := strings.IndexByte(s[i+1:], '"')
			if end < 0 {
				toks = append(toks, token{kind: tkBad, s: s[i:]})
				i = len(s)
				break
			}
			toks = append(toks, token{kind: tkComment, s: s[i+1 : i+1+end]})
			i += end + 2
		case isDigit(c):
			if strings.HasPrefix(s[i:], "24/7") && (i+4 == len(s) || !isDigit(s[i+4])) {
				toks = append(toks, token{kind: tk247, s: "24/7"})
				i += 4
				break
			}
			j := i
			for j < len(s) && isDigit(s[j]) {
				j++
			}
			digits := s[i:j]
			if len(digits) <= 2 && j+2 < len(s) && (s[j] == ':' || s[j] == '.') &&
				isDigit(s[j+1]) && isDigit(s[j+2]) && (j+3 == len(s) || !isDigit(s[j+3])) {
				h, _ := strconv.Atoi(digits)
				m, _ := strconv.Atoi(s[j+1 : j+3])
				if m < 60 && h*60+m <= 2880 {
					toks = append(toks, token{kind: tkTime, s: s[i : j+3], n: h*60 + m})
				} else {
					toks = append(toks, token{kind: tkBad, s: s[i : j+3]})
				}
				i = j + 3
				break
			}
			if len(digits) > 4 {
				toks = append(toks, token{kind: tkBad, s: digits})
			} else {
				n, _ := strconv.Atoi(digits)
				toks = append(toks, token{kind: tkNum, s: digits, n: n})
			}
			i = j
		case isLetter(c):
			j := i
			for j < len(s) && isLetter(s[j]) {
				j++
			}
			toks = append(toks, token{kind: tkWord, s: strings.ToLower(s[i:j])})
			i = j
		case strings.IndexByte("-,;:+[]()", c) >= 0:
			toks = append(toks, token{kind: tkSym, s: string(c)})
			i++
		case c == '|' && i+1 < len(s) && s[i+1] == '|':
			toks = append(toks, token{kind: tkSym, s: "||"})
			i += 2
		default:
			toks = append(toks, token{kind: tkBad, s: string(c)})
			i++
		}
	}
	return toks
}

// normalizeText turns the dashes people paste into "-" and every kind of space into " ".
func normalizeText(s string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		switch {
		case r == '–' || r == '—' || r == '−' || r == '‒' || r == '‐':
			return '-'
		case unicode.IsSpace(r):
			return ' '
		}
		return r
	}, s))
}

var weekdays = map[string]int{"mo": 1, "tu": 2, "we": 3, "th": 4, "fr": 5, "sa": 6, "su": 7}

var months = map[string]time.Month{
	"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
	"jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}

func isSym(t token, s string) bool  { return t.kind == tkSym && t.s == s }
func isWord(t token, s string) bool { return t.kind == tkWord && t.s == s }
func isDay(t token) bool {
	return t.kind == tkWord && (weekdays[t.s] > 0 || t.s == "ph" || t.s == "sh")
}
func isMonth(t token) bool { return t.kind == tkWord && months[t.s] > 0 }
func isVariable(t token) bool {
	return t.kind == tkWord && (t.s == "sunrise" || t.s == "sunset" || t.s == "dawn" || t.s == "dusk")
}

// isBody is a token that can only appear after a rule's selectors.
func isBody(t token) bool {
	return t.kind == tkTime || t.kind == tk247 || t.kind == tkComment || isSym(t, "+") || isVariable(t) ||
		t.kind == tkWord && (t.s == "off" || t.s == "closed" || t.s == "unknown" || t.s == "open")
}

// ---- splitting into rules ----

type ruleToks struct {
	toks       []token
	additional bool // separated from the previous rule by ","
	fallback   bool // after a "||"
}

// splitRules cuts the token stream at ";", "||" and the "," that starts an additional
// rule. A "," belongs to the current rule when its selectors aren't finished ("Mo,We")
// or a time or "sunset" follows it ("09:00-12:00,14:00-18:00").
func splitRules(toks []token) []ruleToks {
	var out []ruleToks
	cur := ruleToks{}
	body, fallback := false, false
	flush := func(additional bool) {
		if len(cur.toks) > 0 {
			out = append(out, cur)
		}
		cur = ruleToks{additional: additional, fallback: fallback}
		body = false
	}
	for i, t := range toks {
		switch {
		case isSym(t, ";"):
			flush(false)
		case isSym(t, "||"):
			fallback = true
			flush(false)
		case isSym(t, ",") && body && i+1 < len(toks) &&
			!(toks[i+1].kind == tkTime || toks[i+1].kind == tk247 || isVariable(toks[i+1])):
			flush(true)
		default:
			if isBody(t) {
				body = true
			}
			cur.toks = append(cur.toks, t)
		}
	}
	flush(false)
	return out
}

// ---- one rule ----

type dateKey struct {
	year  int // 0: every year
	month time.Month
	day   int
}

func (k dateKey) on() string {
	if k.year == 0 {
		return fmt.Sprintf("--%02d-%02d", int(k.month), k.day)
	}
	return fmt.Sprintf("%04d-%02d-%02d", k.year, int(k.month), k.day)
}

type rule struct {
	additional, fallback bool

	always bool // a bare "24/7"
	all247 bool
	// selectors
	allDays bool // no weekday or holiday selector
	days    [8]bool
	ph      bool
	dates   []dateKey
	// times
	spans     []Span
	openEnded bool // "17:00+"
	variable  bool // sunrise ...
	off       bool
	unknown   bool
	open      bool
	comment   bool

	unsupported string // why the rule can't be used; "" when fine
}

func (r *rule) fail(why string) {
	if r.unsupported == "" {
		r.unsupported = why
	}
}

func (r *rule) anyDay() bool {
	for _, d := range r.days {
		if d {
			return true
		}
	}
	return false
}

type parser struct {
	toks []token
	i    int
}

func (p *parser) at(n int) token {
	if p.i+n < len(p.toks) {
		return p.toks[p.i+n]
	}
	return token{kind: tkEOF}
}

func (p *parser) peek() token { return p.at(0) }

// wide reads the selectors before the weekdays: years and dates. Month ranges, week
// numbers and year ranges are recognized but not supported.
func (p *parser) wide(r *rule) {
	for r.unsupported == "" {
		t := p.peek()
		switch {
		case t.kind == tkNum && len(t.s) == 4 && t.n >= 1900 && t.n <= 2100:
			p.i++
			if isSym(p.peek(), "-") {
				r.fail("year range")
				return
			}
			if !isMonth(p.peek()) {
				r.fail("year selector without a date")
				return
			}
			p.dates(r, t.n)
		case isMonth(t):
			p.dates(r, 0)
		case isWord(t, "week"):
			r.fail("week numbers")
		case isWord(t, "easter"):
			r.fail("easter")
		default:
			return
		}
		if isSym(p.peek(), ":") {
			p.i++
		}
	}
}

func isDayNum(t token) bool { return t.kind == tkNum && t.n >= 1 && t.n <= 31 && len(t.s) <= 2 }

// dates reads "Dec 25", "Dec 24-26", "Dec 24-Jan 2" and lists of them with ",".
func (p *parser) dates(r *rule, year int) {
	for {
		m := months[p.peek().s]
		p.i++
		if !isDayNum(p.peek()) {
			r.fail("month or month range")
			return
		}
		d1 := p.peek().n
		p.i++
		m2, d2 := m, d1
		if isSym(p.peek(), "-") {
			p.i++
			switch t := p.peek(); {
			case isDayNum(t):
				d2 = t.n
				p.i++
			case isMonth(t) && isDayNum(p.at(1)):
				m2, d2 = months[t.s], p.at(1).n
				p.i += 2
			default:
				r.fail("date range")
				return
			}
		}
		if !expandDates(r, year, m, d1, m2, d2) {
			return
		}
		if isSym(p.peek(), ",") && isMonth(p.at(1)) {
			p.i++
			continue
		}
		return
	}
}

// maxDateRange bounds a "Dec 24-Jan 2" style range, so one rule can't make a
// year-long list of dates.
const maxDateRange = 62

func expandDates(r *rule, year int, m1 time.Month, d1 int, m2 time.Month, d2 int) bool {
	ref := year
	if ref == 0 {
		ref = 2000 // a leap year, so Feb 29 is allowed in "every year" entries
	}
	start := time.Date(ref, m1, d1, 0, 0, 0, 0, time.UTC)
	end := time.Date(ref, m2, d2, 0, 0, 0, 0, time.UTC)
	if start.Month() != m1 || start.Day() != d1 || end.Month() != m2 || end.Day() != d2 {
		r.fail("no such date")
		return false
	}
	if end.Before(start) {
		if year != 0 {
			r.fail("date range across a year end")
			return false
		}
		end = end.AddDate(1, 0, 0)
	}
	n := 0
	for cur := start; !cur.After(end); cur = cur.AddDate(0, 0, 1) {
		if n++; n > maxDateRange {
			r.fail("date range too long")
			return false
		}
		r.dates = append(r.dates, dateKey{year, cur.Month(), cur.Day()})
	}
	return true
}

// weekdays reads "Mo", "Mo-Fr", "Fr-Mo" (wrapping), "PH", and comma lists of them.
func (p *parser) weekdays(r *rule) {
	for r.unsupported == "" {
		t := p.peek()
		switch {
		case t.kind == tkWord && weekdays[t.s] > 0:
			a, b := weekdays[t.s], weekdays[t.s]
			p.i++
			if isSym(p.peek(), "-") && p.at(1).kind == tkWord && weekdays[p.at(1).s] > 0 {
				b = weekdays[p.at(1).s]
				p.i += 2
			}
			if isSym(p.peek(), "[") {
				r.fail("nth weekday")
				return
			}
			for d := a; ; d = d%7 + 1 {
				r.days[d] = true
				if d == b {
					break
				}
			}
			r.allDays = false
		case isWord(t, "ph"):
			r.ph, r.allDays = true, false
			p.i++
		case isWord(t, "sh"):
			r.fail("school holidays")
			return
		default:
			return
		}
		if isSym(p.peek(), ",") && isDay(p.at(1)) {
			p.i++
			continue
		}
		break
	}
	if isSym(p.peek(), ":") {
		p.i++
	}
}

// addSpan adds from-to, turning a close before the open into one past midnight.
func (r *rule) addSpan(from, to int) {
	switch {
	case from >= 1440:
		r.fail("start time of 24:00 or later")
	case to == from:
		r.fail("empty time range")
	default:
		if to < from {
			to += 1440
		}
		if to > 2880 {
			r.fail("time range longer than a day")
			return
		}
		r.spans = append(r.spans, Span{from, to})
	}
}

// times reads the time selector and modifiers. It stops at anything it doesn't
// understand, leaving it for the caller.
func (p *parser) times(r *rule) {
	for r.unsupported == "" {
		t := p.peek()
		switch {
		case t.kind == tk247:
			r.all247 = true
			p.i++
		case t.kind == tkTime:
			p.i++
			switch n := p.peek(); {
			case isSym(n, "-"):
				p.i++
				switch e := p.peek(); {
				case e.kind == tkTime:
					p.i++
					r.addSpan(t.n, e.n)
					if isSym(p.peek(), "+") {
						p.i++
						r.openEnded = true
					}
				case isVariable(e):
					p.i++
					r.variable = true
				default:
					r.fail("malformed time range")
				}
			case isSym(n, "+"):
				p.i++
				r.openEnded = true
			default:
				r.fail("a point in time")
			}
		case isVariable(t):
			p.i++
			r.variable = true
			if isSym(p.peek(), "-") {
				p.i++
				if e := p.peek(); e.kind == tkTime || isVariable(e) {
					p.i++
				} else {
					r.fail("malformed time range")
				}
			}
		case t.kind == tkWord && (t.s == "off" || t.s == "closed"):
			r.off = true
			p.i++
		case isWord(t, "unknown"):
			r.unknown = true
			p.i++
		case isWord(t, "open"):
			r.open = true
			p.i++
		case t.kind == tkComment:
			r.comment = true
			p.i++
		case isSym(t, ","):
			if n := p.at(1); n.kind == tkEOF || n.kind == tkTime || n.kind == tk247 || isVariable(n) {
				p.i++
				continue
			}
			return
		default:
			return
		}
	}
}

func parseRule(rt ruleToks) rule {
	r := rule{additional: rt.additional, fallback: rt.fallback, allDays: true}
	p := &parser{toks: rt.toks}
	p.wide(&r)
	if r.unsupported == "" {
		p.weekdays(&r)
	}
	if r.unsupported == "" {
		p.times(&r)
	}
	if r.unsupported == "" && p.peek().kind != tkEOF {
		r.fail("unexpected " + describe(p.peek()))
	}
	if r.unsupported != "" {
		return r
	}
	selectorless := r.allDays && len(r.dates) == 0 && !r.ph
	switch {
	case len(r.dates) > 0 && (r.anyDay() || r.ph):
		r.fail("a date combined with weekdays")
	case r.all247 && selectorless && len(r.spans) == 0 && !r.off && !r.openEnded && !r.variable:
		r.always = true
	case r.all247:
		r.spans = append(r.spans, Span{0, 1440})
	}
	switch {
	case r.unsupported != "" || r.always:
	case r.off && (len(r.spans) > 0 || r.openEnded || r.variable):
		r.fail("off with times")
	case len(r.spans) == 0 && !r.off && !r.unknown && !r.openEnded && !r.variable:
		if r.comment {
			r.fail("comment only")
		} else {
			r.fail("no opening times")
		}
	}
	return r
}

func describe(t token) string {
	if t.s == "" {
		return "end of rule"
	}
	return strconv.Quote(t.s)
}

func ruleText(toks []token) string {
	parts := make([]string, len(toks))
	for i, t := range toks {
		parts[i] = t.s
	}
	return strings.Join(parts, " ")
}

// ---- building the schedule ----

// builder collects rules from either syntax into one Schedule.
type builder struct {
	always   bool
	days     [8][]Span
	dates    map[string]*DateRule
	holidays *string
	partial  Partial
	warns    []Warning
}

func newBuilder() *builder { return &builder{dates: map[string]*DateRule{}} }

func (b *builder) warn(code, format string, args ...any) {
	b.warns = append(b.warns, Warning{code, fmt.Sprintf(format, args...)})
}

func (b *builder) setPartial(p Partial) {
	if p == PartialRestrictive || b.partial == "" || b.partial == PartialNone {
		b.partial = p
	}
}

// expandAlways turns a "24/7" into seven full days, once something has to differ.
func (b *builder) expandAlways() {
	if !b.always {
		return
	}
	b.always = false
	for d := 1; d <= 7; d++ {
		b.days[d] = []Span{{0, 1440}}
	}
}

func (b *builder) setHolidays(v string) { b.holidays = &v }

func (b *builder) dateRule(on string) *DateRule {
	if r, ok := b.dates[on]; ok {
		return r
	}
	r := &DateRule{On: on}
	b.dates[on] = r
	return r
}

// apply folds one parsed OSM rule into the builder, in order: a normal rule replaces
// what earlier rules said about the same days; an additional rule adds to it.
//
// Date rules and PH rules are exceptions whatever their position: a rule such as
// "Mo-Fr 09:00-17:00" written after "PH off" doesn't reopen the holiday here (the spec
// would, on weekday holidays; in practice exceptions are written last).
func (b *builder) apply(r rule, text string) {
	switch {
	case r.fallback:
		b.warn("fallback", "%q: fallback rules (||) are not evaluated", text)
		b.setPartial(PartialRestrictive)
		return
	case r.unsupported != "":
		b.warn("unsupported", "%q: %s", text, r.unsupported)
		b.setPartial(PartialRestrictive)
		return
	case r.unknown:
		b.warn("unknown_state", "%q says unknown", text)
		b.setPartial(PartialRestrictive)
		return
	case r.always:
		b.days = [8][]Span{}
		b.always = !r.additional
		if r.additional {
			b.always = true
			b.expandAlways()
		}
		return
	}
	if r.comment && !r.off {
		b.warn("comment", "%q has a comment that may restrict the hours", text)
		b.setPartial(PartialRestrictive)
	}
	if r.openEnded {
		b.warn("open_ended", "%q has no closing time; the open-ended part is dropped", text)
		b.setPartial(PartialAdditive)
	}
	if r.variable {
		b.warn("variable_time", "%q uses sunrise/sunset times, which are dropped", text)
		b.setPartial(PartialAdditive)
	}
	switch {
	case len(r.dates) > 0:
		b.applyDates(r, text)
	default:
		if r.ph {
			b.applyPH(r, text)
		}
		if r.allDays || r.anyDay() {
			b.applyDays(r, text)
		}
	}
}

func (b *builder) applyPH(r rule, text string) {
	switch {
	case r.off && len(r.spans) == 0:
		b.setHolidays(HolidaysClosed)
	default:
		b.warn("holiday_hours", "%q: holiday hours can't be stored; holidays stays unstated", text)
		if !r.additional {
			b.holidays = nil
		}
	}
}

func (b *builder) applyDays(r rule, text string) {
	if r.off && r.additional {
		b.warn("additive_off", "%q: an additional off rule on weekdays is not evaluated", text)
		b.setPartial(PartialRestrictive)
		return
	}
	b.expandAlways()
	for d := 1; d <= 7; d++ {
		if !(r.allDays || r.days[d]) {
			continue
		}
		if !r.additional {
			b.days[d] = nil
		}
		b.days[d] = append(b.days[d], r.spans...)
	}
}

func (b *builder) applyDates(r rule, text string) {
	if r.openEnded || r.variable {
		// Not a time we can store on a date: the date may be open or closed unlike the
		// weekly hours, in either direction.
		b.warn("unsupported", "%q: open-ended or sunrise/sunset times on a date", text)
		b.setPartial(PartialRestrictive)
		return
	}
	for _, k := range r.dates {
		dr := b.dateRule(k.on())
		switch {
		case r.off:
			dr.Closed, dr.Spans = true, nil
		case r.additional && !dr.Closed:
			dr.Spans = append(dr.Spans, r.spans...)
		default:
			dr.Closed, dr.Spans = false, append([]Span(nil), r.spans...)
		}
	}
}

// finish builds the normalized schedule, or ErrNoHours when there's not a single open
// span in it: rules that only close things say nothing about when a place is open.
func (b *builder) finish() (Schedule, error) {
	if b.always && (len(b.dates) > 0 || b.holidays != nil) {
		b.expandAlways()
	}
	s := Schedule{V: Version, TZ: TimeZone, Always: b.always, Holidays: b.holidays, Partial: b.partial}
	if s.Partial == "" {
		s.Partial = PartialNone
	}
	for d := 1; d <= 7; d++ {
		for _, sp := range mergeSpans(b.days[d]) {
			s.Weekly = append(s.Weekly, WeeklySpan{d, sp.From, sp.To})
		}
	}
	for _, r := range b.dates {
		s.Dates = append(s.Dates, *r)
	}
	if !s.Always && len(s.Weekly) == 0 {
		return Schedule{}, ErrNoHours
	}
	s.Normalize()
	if err := s.Validate(); err != nil {
		return Schedule{}, err
	}
	return s, nil
}

// ParseOSM parses the OpenStreetMap opening_hours syntax
// (https://wiki.openstreetmap.org/wiki/Key:opening_hours/specification).
//
// Supported: 24/7; weekday lists and ranges, wrapping ones too (Mo-Fr, Sa,Su, Fr-Mo);
// times and several spans per day; spans past midnight (22:00-02:00) and extended times
// (22:00-26:00, up to 48:00); "." as the time separator; ";" rules where a later rule for
// the same days replaces earlier ones; "," additional rules that add; off and closed;
// rules without weekdays (every day); PH off and PH closed; single dates and date ranges
// (Dec 25 off, Dec 24-26 off, Dec 31-Jan 2 off, Dec 24 09:00-15:00, 2026 Dec 25 off);
// case, extra spaces and en dashes. A "24/7" that stands alone is Always; with other
// rules it becomes seven full days.
//
// Understood but not stored, and marked partial (never guessed): month ranges
// (Apr-Oct), week numbers, year ranges, nth weekdays (Mo[1]), school holidays (SH),
// easter, "||" fallbacks, comments on rules with times, "unknown", "off" with times and
// anything we can't classify are restrictive. Open-ended times (17:00+) and
// sunrise/sunset times are additive: for "17:00+" the span is dropped, not given an
// invented closing time, and the days of a rule that has only such times lose their
// earlier spans. PH rules with times set nothing: holidays stays null.
//
// Not allowed: 12-hour times (ErrTwelveHour), input over MaxInputLen (ErrTooLong). When
// nothing open could be parsed the error is ErrNoHours: the caller stores no schedule,
// the hours are unknown.
func ParseOSM(s string) (Schedule, []Warning, error) {
	if len(s) > MaxInputLen {
		return Schedule{}, nil, ErrTooLong
	}
	toks := tokenize(normalizeText(s))
	for _, t := range toks {
		if isWord(t, "am") || isWord(t, "pm") {
			return Schedule{}, nil, ErrTwelveHour
		}
	}
	b := newBuilder()
	for _, rt := range splitRules(toks) {
		b.apply(parseRule(rt), ruleText(rt.toks))
	}
	sched, err := b.finish()
	return sched, b.warns, err
}
