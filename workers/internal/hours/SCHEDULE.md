# Normalized schedule, version 1

The format `ParseOSM` and `ParseSchemaOrg` produce and `StateAt` reads. A TypeScript
evaluator in the API reads the same JSON, so this is a contract. The shared test vectors
are in `testdata/vectors.json`; both implementations must agree on every one of them.

```json
{
  "v": 1,
  "tz": "America/New_York",
  "always": false,
  "weekly": [ { "d": 1, "from": 540, "to": 1020 } ],
  "dates": [
    { "on": "2026-12-25", "closed": true,  "spans": [] },
    { "on": "--12-24",    "closed": false, "spans": [ { "from": 540, "to": 900 } ] }
  ],
  "holidays": null,
  "partial": "none"
}
```

Every key is always present (empty arrays, `null` holidays), so readers never have to
check for missing keys.

## Fields

- `v`: `1`.
- `tz`: `"America/New_York"`. The only zone; hours are always evaluated there.
- `always`: `true` is open 24/7. Then `weekly` and `dates` are empty and `holidays` is
  `null`. (`24/7` with any holiday or date exception is stored as seven full days.)
- `weekly`: spans that repeat every week, sorted by `(d, from)`.
  - `d`: ISO weekday, 1 = Monday ... 7 = Sunday, the local day the span STARTS on.
  - `from`: minutes after local midnight, 0..1439, inclusive.
  - `to`: minutes after the same midnight, `from + 1` .. 2880, exclusive. `to > 1440` runs
    past midnight into the next day: Fri 22:00-02:00 is `{d:5, from:1320, to:1560}`;
    closing at "24:00" is 1440; a day open all day is `{from:0, to:1440}`; Sunday 22:00
    to Monday 02:00 is `{d:7, from:1320, to:1560}`.
  - Several spans on one day are split shifts. Spans of a day are sorted, and neither
    overlap nor touch (touching spans are merged: 09:00-12:00 + 12:00-15:00 is 09:00-15:00).
- `dates`: overrides for a local date, sorted by `on`, one entry per `on`.
  - `on`: `"YYYY-MM-DD"` (that date) or `"--MM-DD"` (every year; `--02-29` allowed).
  - Either `closed: true` with `spans: []`, or `closed: false` with at least one span
    (`{from, to}`, same rules as above).
  - A specific-year entry beats a yearly one.
  - An override replaces the weekly spans that START on that date. A span from the
    previous day that runs past midnight still applies on the override day.
- `holidays`: what the source says about public holidays. `"closed"`, `"open"` (the
  weekday's regular spans apply) or `null` (not stated).
- `partial`: `"none"`, `"additive"` or `"restrictive"`, set when part of the source
  could not be understood.
  - `additive`: the part dropped could only ADD open time, so a computed "closed" isn't
    trustworthy.
  - `restrictive`: the dropped part might REMOVE open time (an unparsed rule with
    off/closed, an unsupported month, date or week range, anything unclassified), so
    "open" isn't trustworthy either.

The different services of one venue (regular hours, kitchen, bar) are separate schedules
stored as separate facts; a schedule has no "kind".

## Evaluation

`state(schedule, instant)` is `"open"`, `"closed"` or `"unknown"`. All in New York time.

1. A missing schedule (`null`) is `"unknown"`. Missing hours are never "closed".
2. `always`: open.
3. Convert the instant to New York local time: a local date and a minute of day. Never
   add durations to midnight (see DST below).
4. Collect the spans that STARTED on the previous local date and run past midnight
   (`to > 1440`), and the spans that start on the local date. For each of those two start
   dates:
   - A `dates` entry for it (the specific year first, else the yearly one) gives its
     spans (`closed: true` gives none), and nothing else applies.
   - Otherwise, if the start date is a public holiday (below): `holidays` `"closed"` gives
     no spans; `"open"` gives the weekly spans; `null` puts the date in doubt.
   - Otherwise the weekly spans of its weekday.
5. The minute is inside a span when `from <= minute < to` (for the previous day's span,
   `minute < to - 1440`). Open if inside a span that isn't in doubt. Otherwise unknown
   if the local date is a holiday in doubt, or the previous date is one and it has a span
   reaching the minute. Otherwise closed.
6. Apply `partial`: `additive` turns closed into unknown; `restrictive` turns open and
   closed into unknown.

### Public holidays

A fixed list: New Year's Day (Jan 1), Independence Day (Jul 4), Thanksgiving (4th
Thursday of November) and Christmas Day (Dec 25). Observed days and other holidays are
not included.

### DST

Spans are local wall-clock times; the minute of day comes from the local clock reading.

- Spring forward (2026-03-08, 02:00 -> 03:00): the missing hour never occurs. A span
  01:00-04:00 is open at 01:30 EST and at 03:30 EDT. A span closing at 02:30 effectively
  closes at 03:00 EDT.
- Fall back (2026-11-01, 01:00-02:00 happens twice): both occurrences have the same
  minutes of day and the same answer. A span ending 01:30 is open during the first
  01:00-01:30 and during the repeated one. An overnight Saturday 22:00-02:00 covers both
  01:xx hours.
