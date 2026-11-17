package hours

import "time"

// Holiday is a major US public holiday on a concrete date.
type Holiday struct {
	Name  string
	Month time.Month
	Day   int
}

// PublicHolidays lists the holidays schedules care about in a year: New Year's Day
// (Jan 1), Independence Day (Jul 4), Thanksgiving (4th Thursday of November) and
// Christmas Day (Dec 25). The list is fixed. Observed days (a Saturday holiday taken on
// Friday) and other holidays are not included: a venue that closes for them says so
// with a dates entry.
func PublicHolidays(year int) []Holiday {
	return []Holiday{
		{"New Year's Day", time.January, 1},
		{"Independence Day", time.July, 4},
		{"Thanksgiving", time.November, thanksgiving(year)},
		{"Christmas Day", time.December, 25},
	}
}

// HolidayOn names the holiday that falls on a date, if any.
func HolidayOn(year int, month time.Month, day int) (name string, ok bool) {
	for _, h := range PublicHolidays(year) {
		if h.Month == month && h.Day == day {
			return h.Name, true
		}
	}
	return "", false
}

// thanksgiving is the day of November of the fourth Thursday.
func thanksgiving(year int) int {
	first := time.Date(year, time.November, 1, 0, 0, 0, 0, time.UTC).Weekday()
	firstThursday := 1 + (int(time.Thursday)-int(first)+7)%7
	return firstThursday + 21
}
