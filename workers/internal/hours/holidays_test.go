package hours

import (
	"testing"
	"time"
)

func TestZoneLoads(t *testing.T) {
	// time/tzdata is imported, so this works with no system zone database.
	if NYC.String() != TimeZone {
		t.Fatalf("zone %s", NYC)
	}
	_, off := time.Date(2026, 7, 1, 12, 0, 0, 0, NYC).Zone()
	if off != -4*3600 {
		t.Fatalf("July offset %d, want EDT", off)
	}
}

func TestHolidays(t *testing.T) {
	cases := []struct {
		y    int
		m    time.Month
		d    int
		name string
	}{
		{2026, time.January, 1, "New Year's Day"},
		{2026, time.July, 4, "Independence Day"},
		{2026, time.November, 26, "Thanksgiving"},
		{2027, time.November, 25, "Thanksgiving"},
		{2028, time.November, 23, "Thanksgiving"}, // Nov 1 2028 is a Wednesday
		{2029, time.November, 22, "Thanksgiving"}, // Nov 1 2029 is a Thursday
		{2030, time.November, 28, "Thanksgiving"}, // Nov 1 2030 is a Friday
		{2026, time.December, 25, "Christmas Day"},
	}
	for _, c := range cases {
		if name, ok := HolidayOn(c.y, c.m, c.d); !ok || name != c.name {
			t.Errorf("%d-%02d-%02d: got %q %v, want %q", c.y, c.m, c.d, name, ok, c.name)
		}
	}
	for _, c := range []struct {
		y    int
		m    time.Month
		d    int
		want string
	}{
		{2026, time.November, 19, "third Thursday"},
		{2027, time.November, 26, "the Friday after"},
		{2026, time.July, 3, "Independence Day observed is not modelled"},
		{2026, time.December, 24, "Christmas Eve"},
	} {
		if name, ok := HolidayOn(c.y, c.m, c.d); ok {
			t.Errorf("%d-%02d-%02d (%s) is not a listed holiday, got %q", c.y, c.m, c.d, c.want, name)
		}
	}
	if n := len(PublicHolidays(2026)); n != 4 {
		t.Fatalf("%d holidays, want 4", n)
	}
}
