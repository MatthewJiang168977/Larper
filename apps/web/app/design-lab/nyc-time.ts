const wallClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
});

function nycParts(instant: number) {
  const parts = wallClock.formatToParts(instant);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day"), minutes: part("hour") * 60 + part("minute") };
}

/** "19:30" -> minutes after midnight, or null when it isn't a time. */
export function parseClock(text: string | null) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text ?? "");
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The instant when NYC clocks read `minutes` after midnight on `day` (default: today in NYC). */
export function nycInstant(minutes: number, day?: { year: number; month: number; day: number }, now = Date.now()) {
  const date = day ?? nycParts(now);
  let guess = Date.UTC(date.year, date.month - 1, date.day) + minutes * 60_000 + 5 * 3_600_000;
  // Two passes land on the right UTC offset, including on the days the clocks change.
  for (let pass = 0; pass < 2; pass++) {
    const shown = nycParts(guess);
    guess += (minutes - shown.minutes) * 60_000;
  }
  return new Date(guess);
}
