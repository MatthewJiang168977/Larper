package hours

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestParseSchemaOrgWarnings(t *testing.T) {
	cases := []struct {
		in      string
		partial Partial
		codes   []string
	}{
		{`"Mo-Fr 09:00-17:00"`, PartialNone, nil},
		{`["Mo-Fr 09:00-17:00","call us"]`, PartialRestrictive, []string{"unsupported"}},
		{`[{"dayOfWeek":"Monday","opens":"09:00","closes":"17:00"},
		  {"dayOfWeek":"Monday","opens":"09:00","closes":"17:00","validFrom":"2026-06-01"}]`, PartialRestrictive, []string{"unsupported"}},
		{`[{"dayOfWeek":"Monday","opens":"09:00","closes":"17:00"},
		  {"dayOfWeek":"PublicHolidays","opens":"10:00","closes":"12:00"}]`, PartialNone, []string{"holiday_hours"}},
	}
	for _, c := range cases {
		s, ws, err := ParseSchemaOrg(json.RawMessage(c.in))
		if err != nil {
			t.Errorf("%s: %v", c.in, err)
			continue
		}
		if s.Partial != c.partial || !slices.Equal(codes(ws), c.codes) {
			t.Errorf("%s: partial %s warnings %v, want %s %v", c.in, s.Partial, codes(ws), c.partial, c.codes)
		}
	}
}

func TestParseSchemaOrgPlainText(t *testing.T) {
	// Not JSON at all: taken as the text form.
	s, _, err := ParseSchemaOrg(json.RawMessage("Mo-Fr 09:00-17:00"))
	if err != nil || len(s.Weekly) != 5 {
		t.Fatalf("%+v %v", s, err)
	}
}

func TestParseSchemaOrgSpecDateWeekdayMismatch(t *testing.T) {
	// 2026-12-25 is a Friday; a specification for Mondays doesn't apply to it.
	in := `[{"dayOfWeek":"Tuesday","opens":"09:00","closes":"17:00"},
	        {"dayOfWeek":"Monday","opens":"10:00","closes":"11:00","validFrom":"2026-12-25","validThrough":"2026-12-25"}]`
	s, ws, err := ParseSchemaOrg(json.RawMessage(in))
	if err != nil || len(s.Dates) != 0 || len(ws) != 1 {
		t.Fatalf("%+v %v %v", s, ws, err)
	}
}

func TestParseSchemaOrgGarbage(t *testing.T) {
	for _, in := range []string{
		``, `null`, `true`, `42`, `-1`, `[]`, `{}`, `[[[[[[[[["Mo-Fr 09:00-17:00"]]]]]]]]]`, `"`, `{`, `[`, `{"a":`,
		`{"openingHours":{"openingHours":{"openingHours":{"openingHours":{"openingHours":"Mo 10:00-11:00"}}}}}`,
		`{"dayOfWeek":{"x":1},"opens":"09:00","closes":"10:00"}`, `{"dayOfWeek":[1,2],"opens":"09:00","closes":"10:00"}`,
		`{"dayOfWeek":"Monday","opens":9,"closes":10}`, `{"dayOfWeek":"Monday","opens":"25:00","closes":"26:00"}`,
		`{"dayOfWeek":"Monday","opens":"24:00","closes":"02:00"}`, `{"dayOfWeek":"Monday","opens":"9:0","closes":"10:00"}`,
		`{"dayOfWeek":"Monday","opens":"09:00","closes":"10:00","validFrom":"x","validThrough":"y"}`,
		`{"dayOfWeek":"Monday","opens":"09:00","closes":"10:00","validFrom":"2026-02-30","validThrough":"2026-02-30"}`,
		`{"dayOfWeek":"Funday","opens":"09:00","closes":"10:00"}`, `"Mo-Fr"`, `"Mo,"`, `",Mo"`, `";"`, `"Mo-Fr 10:00"`,
		`"\u0000"`, "\"" + strings.Repeat("Mo-Fr 09:00-17:00 ", 100) + "\"", strings.Repeat("[", 5000),
	} {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("ParseSchemaOrg(%.60q) panicked: %v", in, r)
				}
			}()
			s, _, err := ParseSchemaOrg(json.RawMessage(in))
			if err != nil {
				return
			}
			if err := s.Validate(); err != nil {
				t.Errorf("ParseSchemaOrg(%.60q): invalid schedule: %v", in, err)
			}
		}()
	}
	big := json.RawMessage(strings.Repeat(" ", MaxSchemaOrgLen+1))
	if _, _, err := ParseSchemaOrg(big); !errors.Is(err, ErrTooLong) {
		t.Errorf("over the limit: %v", err)
	}
}

func FuzzParseSchemaOrg(f *testing.F) {
	f.Add(`"Mo-Fr 09:00-17:00"`)
	f.Add(`[{"dayOfWeek":["Monday"],"opens":"09:00","closes":"02:00","validFrom":"2026-12-25","validThrough":"2026-12-25"}]`)
	f.Fuzz(func(t *testing.T, in string) {
		s, _, err := ParseSchemaOrg(json.RawMessage(in))
		if err != nil {
			return
		}
		if err := s.Validate(); err != nil {
			t.Fatalf("%q: invalid schedule: %v", in, err)
		}
	})
}
