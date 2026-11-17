package hours

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

func codes(ws []Warning) []string {
	var out []string
	for _, w := range ws {
		out = append(out, w.Code)
	}
	return out
}

func TestParseOSMWarnings(t *testing.T) {
	cases := []struct {
		in      string
		partial Partial
		codes   []string
	}{
		{"Mo-Fr 09:00-17:00", PartialNone, nil},
		{"Mo-Fr 09:00-17:00; PH off", PartialNone, nil},
		{"Mo-Fr 09:00-17:00; PH 10:00-16:00", PartialNone, []string{"holiday_hours"}},
		{"Mo-Fr 09:00-17:00; Sa 17:00+", PartialAdditive, []string{"open_ended"}},
		{"Mo-Fr 09:00-17:00; Sa sunrise-sunset", PartialAdditive, []string{"variable_time"}},
		{"Mo-Fr 09:00-17:00; Apr-Oct Sa 10:00-12:00", PartialRestrictive, []string{"unsupported"}},
		{"Mo-Fr 09:00-17:00 || Sa 10:00-12:00", PartialRestrictive, []string{"fallback"}},
		{"Mo-Fr 09:00-17:00; Sa unknown", PartialRestrictive, []string{"unknown_state"}},
		{`Mo-Fr 09:00-17:00 "ring first"`, PartialRestrictive, []string{"comment"}},
		{"Mo-Fr 09:00-17:00; Dec 24 09:00-12:00; Mo-Fr 09:00-17:00", PartialRestrictive, []string{"exception-then-rule"}},
		{"PH off; Mo-Fr 09:00-17:00", PartialRestrictive, []string{"exception-then-rule"}},
		{"Mo-Fr 09:00-17:00; Dec 25 off, Sa 10:00-14:00", PartialRestrictive, []string{"exception-then-rule"}},
		{"Mo-Fr 09:00-17:00; Dec 25 off; 24/7", PartialRestrictive, []string{"exception-then-rule"}},
		{"Mo-Fr 09:00-17:00; Sa 10:00-14:00; PH off; Dec 25 off", PartialNone, nil},
		{"Mo-Fr 09:00-17:00; Sa 17:00+; Su unknown", PartialRestrictive, []string{"open_ended", "unknown_state"}},
	}
	for _, c := range cases {
		s, ws, err := ParseOSM(c.in)
		if err != nil {
			t.Errorf("%q: %v", c.in, err)
			continue
		}
		if s.Partial != c.partial || !slices.Equal(codes(ws), c.codes) {
			t.Errorf("%q: partial %s warnings %v, want %s %v", c.in, s.Partial, codes(ws), c.partial, c.codes)
		}
	}
}

// What the parse means for evaluation: dropped parts make the answer unknown rather
// than wrong.
func TestParseOSMEvaluates(t *testing.T) {
	cases := []struct {
		in   string
		at   string
		want State
	}{
		{"Mo-Fr 09:00-17:00; Sa 17:00+", "2026-07-11T22:00:00Z", Unknown}, // Saturday evening: may well be open
		{"Mo-Fr 09:00-17:00; Sa 17:00+", "2026-07-08T16:00:00Z", Open},    // Wednesday noon is still open
		{"Mo-Fr 09:00-17:00; Sa sunrise-sunset", "2026-07-11T16:00:00Z", Unknown},
		{"Mo-Fr 09:00-17:00; Apr-Oct Sa 10:00-14:00", "2026-07-08T16:00:00Z", Unknown},
		{"Mo-Fr 09:00-17:00; PH off", "2026-07-08T16:00:00Z", Open},
		{"Mo-Fr 09:00-17:00; PH off", "2026-11-26T17:00:00Z", Closed},
		{"Mo-Fr 09:00-17:00; Dec 24-26 off", "2027-12-24T17:00:00Z", Closed},
		{"Tu-Su 17:00-02:00; Mo off", "2026-07-13T05:00:00Z", Open}, // Sunday night's tail, Monday 01:00
		{"Tu-Su 17:00-02:00; Mo off", "2026-07-13T22:00:00Z", Closed},
		{"24/7", "2026-12-25T17:00:00Z", Open},
		{"24/7; PH off", "2026-12-25T17:00:00Z", Closed},
		{"24/7; PH off", "2026-12-26T17:00:00Z", Open},
	}
	for _, c := range cases {
		if got := StateAt(mustParseOSM(t, c.in), mustAt(t, c.at)); got != c.want {
			t.Errorf("%q at %s: %s, want %s", c.in, c.at, got, c.want)
		}
	}
}

func TestParseOSMErrors(t *testing.T) {
	long := strings.Repeat("Mo 09:00-10:00; ", 70)
	if len(long) <= MaxInputLen {
		t.Fatal("test input too short")
	}
	if _, _, err := ParseOSM(long); !errors.Is(err, ErrTooLong) {
		t.Errorf("long input: %v", err)
	}
	if _, _, err := ParseOSM(long[:MaxInputLen]); err != nil {
		t.Errorf("input at the limit parses: %v", err)
	}
	for _, in := range []string{"Mo-Fr 9am-5pm", "Mo-Fr 9:00 AM - 5:00 PM", "Mo 10:00-11:00 pm"} {
		if _, _, err := ParseOSM(in); !errors.Is(err, ErrTwelveHour) {
			t.Errorf("%q: %v", in, err)
		}
	}
	for _, in := range []string{"", " ", "Mo-Fr", "off", "Dec 25 off", "sunrise-sunset", "Apr-Oct: Mo-Su 10:00-18:00"} {
		if _, _, err := ParseOSM(in); !errors.Is(err, ErrNoHours) {
			t.Errorf("%q: %v", in, err)
		}
	}
}

// garbage is input ParseOSM has to take without panicking or looping. Whatever it
// returns without an error must be a valid schedule.
var garbage = []string{
	"", ";", ";;;", ",,,", "||", "|", "||||", "-", "+", ":", "[", "]", "()", "\"", "\"\"", "\"unterminated",
	"Mo-", "-Mo", "Mo-Fr-Su", "Mo,", ",Mo", "Mo,,Fr 09:00-10:00", "Mo-Fr 09:00-", "Mo-Fr -10:00", "Mo-Fr 09:00--10:00",
	"Mo-Fr 09:00-10:00-11:00", "09:00", "09:00+", "+09:00", "09:00-10:00+ +", "Mo[", "Mo[]", "Mo[1", "Mo[1]-Fr",
	"Mo[-1]", "Mo[1,3] 10:00-11:00", "Dec", "Dec 99", "Dec 0", "Dec 25-", "Dec 25-Jan", "Dec 25-Jan 99", "Dec 31-Jan 1 off",
	"Dec 1-Nov 30 off", "Jan 1-Dec 31 off", "Feb 29 off", "Feb 30 off", "2026", "2026 Mo", "2026-", "2026-2027",
	"99999 Dec 25 off", "0000 Dec 25 off", "week", "week 1-53/2 Mo 10:00-11:00", "easter off", "Mo-Su 24:00-48:00",
	"Mo 48:00-49:00", "Mo 99:99-99:99", "Mo 12:60-13:00", "Mo 1:2-3:4", "Mo 12:00-12:00", "Mo 00:00-00:00", "Mo 24:00-25:00",
	"Mo 10:00-09:59", "Mo 10:00-58:00", "24/7 24/7", "24/7;24/7", "24/7 Mo", "Mo 24/7", "24/7/7", "24/", "/7",
	"PH", "PH,PH", "PH,SH,Mo 10:00-11:00", "SH", "PH off; PH off", "Mo,PH,Su,SH off", "off off off", "open", "closed; closed",
	"unknown unknown", "\"a\" \"b\"", "\"a\";\"b\"", "Mo \"x\" 10:00-11:00", "Mo 10:00-11:00 \"x\" \"y\"", "Mo 10:00-11:00 off",
	"sunrise", "sunset-sunrise", "sunrise-", "(sunrise+01:00)-(sunset)", "dawn-dusk", "Mo sunrise-17:00", "Mo 09:00-sunset",
	"9am", "Mo 9pm-10pm", "\x00", "\xff\xfe", "Mo\x00Fr", "Mo 09:00-10:00", "Mo—Fr 09:00‒10:00", "☃",
	"Mo-Fr 09:00-17:00 Sa 10:00-14:00", "Mo-Fr 09:00-17:00;;;Sa 10:00-14:00,,", "Mo-Fr 09:00-17:00, ", "Mo-Fr 09:00-17:00,",
	"Mo-Fr 09:00-17:00 || || Sa 10:00-14:00", "|| Mo 10:00-11:00", "Mo 10:00-11:00 ||",
	"Mo,Tu,We,Th,Fr,Sa,Su,Mo,Tu,We 10:00-11:00", "Su-Mo-Tu 10:00-11:00", "Sa-Sa 10:00-11:00", "Su-Su 10:00-11:00",
	"Dec 25 Mo off", "Mo Dec 25 off", "Dec 25 PH off", "PH Dec 25 off", "Dec 25 off; Dec 25 10:00-12:00; Dec 25 off",
	"Dec 25, Dec 26 10:00-12:00, Dec 27 off", "Dec 24,26 off", "Dec 24,Dec 26 off", "Dec 24, off",
	"Mo-Fr 09:00-17:00; 24/7", "24/7, Mo 10:00-11:00", "24/7; Mo off", "24/7; Mo-Su off", "Mo-Su off; 24/7",
	"Mo 10:00-11:00, Mo off", "Mo off, Mo 10:00-11:00", "Mo off; Mo off", "Mo off, Tu off",
	"Mo-Fr 09:00-12:00,13:00-17:00,18:00-22:00,23:00-23:30", "Mo 00:00-24:00,00:00-24:00,12:00-36:00",
	"Mo 10:00-11:00,", "Mo 10:00-11:00 ,Tu", "Mo 10:00-11:00 , Tu 10:00-11:00",
	"\"Mo-Fr 09:00-17:00\"", "'Mo-Fr 09:00-17:00'", "Mo-Fr 09:00–17:00; PH off \"x; y, z || w\"",
	"Mo-Fr 09:00-17:00 (by appointment)", "Mo-Fr (09:00-17:00)", "Mo-Fr 09:00-17:00 [x]",
	"Mo{1}", "Mo-Fr 09:00-17:00 & Sa", "Mo-Fr 09:00-17:00 \\ ", "Mo-Fr 09:00:00-17:00:00", "Mo-Fr 09:00:30-17:00",
	"12345678901234567890", "Mo 12345678901234567890:00-10:00", "Mo 10:00-11:00 12345678901234567890",
	"Mo 1.00-2.00", "Mo 1.0-2.0", "Mo 01.00.00-02.00", "Dec 24.25 off", "Dec 24:25 off",
	"Mo-Fr 09:00-17:00;" + strings.Repeat("Dec 1-Jan 31 off;", 40),
	strings.Repeat("(", 500), strings.Repeat("[", 500), strings.Repeat("\"", 501), strings.Repeat("|", 501),
	strings.Repeat(",", 1000), strings.Repeat(";", 1000), strings.Repeat("Mo", 500), strings.Repeat("Mo,", 300),
	strings.Repeat("Mo-Fr 09:00-17:00,", 50), strings.Repeat("Mo 09:00-10:00;", 70), strings.Repeat("9", 1000),
	strings.Repeat("Dec 25 off,", 90), strings.Repeat("Mo 00:00-24:00,", 60),
}

func TestParseOSMGarbage(t *testing.T) {
	for _, in := range garbage {
		checkParseOSM(t, in)
	}
}

func checkParseOSM(t testing.TB, in string) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("ParseOSM(%q) panicked: %v", in, r)
			}
		}()
		s, _, err := ParseOSM(in)
		if err != nil {
			return
		}
		if err := s.Validate(); err != nil {
			t.Errorf("ParseOSM(%q) returned an invalid schedule: %v", in, err)
		}
		if _, err := json.Marshal(s); err != nil {
			t.Errorf("ParseOSM(%q): %v", in, err)
		}
		StateAt(&s, time.Date(2026, 12, 25, 12, 0, 0, 0, NYC))
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("ParseOSM(%q) did not return", in)
	}
}

func FuzzParseOSM(f *testing.F) {
	for _, in := range garbage {
		f.Add(in)
	}
	for _, in := range []string{
		"24/7", "Mo-Fr 09:00-17:00; PH off", "Tu-Su 17:00-02:00; Mo off", "Mo-Th 11:00-22:00; Fr,Sa 11:00-24:00; Su 12:00-21:00",
		"Mo-Fr 08:00-12:00, We 14:00-18:00", "Dec 24-26 off; 2026 Dec 25 10:00-12:00",
	} {
		f.Add(in)
	}
	f.Fuzz(func(t *testing.T, in string) {
		s, _, err := ParseOSM(in)
		if err != nil {
			return
		}
		if err := s.Validate(); err != nil {
			t.Fatalf("ParseOSM(%q) returned an invalid schedule: %v", in, err)
		}
		StateAt(&s, time.Date(2026, 7, 4, 3, 0, 0, 0, NYC))
	})
}
