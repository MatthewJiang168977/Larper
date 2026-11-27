import { validateSchedule, type DateRule, type Schedule, type Span, type WeeklySpan } from './schedule';

// The curator's opening-hours text, in the same syntax as the hours-pilot CSV (the OSM
// opening_hours *syntax*; the values are typed by a person, never OSM data).
//
// A STRICT SUBSET of what the Go importer (workers/internal/hours ParseOSM) accepts: weekday
// lists and ranges, time spans, off/closed, 24/7, PH off, single dates. Anything else is
// refused, so nothing is ever stored half-understood. testdata/parse-vectors.json is checked by
// both this parser's tests and the Go tests: keep the two copies identical.

export const MAX_HOURS_TEXT = 1024;

export class HoursTextError extends Error {}

const DAYS: Record<string, number> = { mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, su: 7 };
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAY = 1440;

const SELECTOR = '(?:mo|tu|we|th|fr|sa|su)(?:\\s*-\\s*(?:mo|tu|we|th|fr|sa|su))?';
const WEEKDAYS_RULE = new RegExp(`^(${SELECTOR}(?:\\s*,\\s*${SELECTOR})*)\\s*:?\\s+(.+)$`);
const DATE_RULE = /^(?:(\d{4})\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})\s*:?\s+(.+)$/;
const SPAN = /^(\d{1,2})[:.](\d{2})\s*-\s*(\d{1,2})[:.](\d{2})$/;

const fail = (rule: string, why: string): never => {
  throw new HoursTextError(`"${rule}": ${why}`);
};

function parseSpans(body: string, rule: string): Span[] {
  return body.split(',').map((part) => {
    const m = SPAN.exec(part.trim());
    if (!m) return fail(rule, 'use 24-hour times like 09:00-17:00, or off');
    const [h1, m1, h2, m2] = m.slice(1).map(Number);
    const from = h1 * 60 + m1;
    let to = h2 * 60 + m2;
    if (m1 > 59 || m2 > 59 || from >= DAY || to > 2 * DAY) return fail(rule, 'no such time');
    if (to === from) return fail(rule, 'opens and closes at the same time');
    if (to < from) to += DAY;
    return { from, to };
  });
}

// Sorted, overlapping and touching spans merged (Go's mergeSpans).
function merge(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

const isOff = (body: string) => body === 'off' || body === 'closed';

/** The normalized schedule for the text, or a HoursTextError saying what couldn't be read. */
export function parseHoursText(input: string): Schedule {
  if (input.length > MAX_HOURS_TEXT) throw new HoursTextError('too long');
  const text = input.replace(/[‐‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
  if (text === '24/7') return { v: 1, tz: 'America/New_York', always: true, weekly: [], dates: [], holidays: null, partial: 'none' };

  const days: Span[][] = [[], [], [], [], [], [], [], []];
  const dates = new Map<string, DateRule>();
  let holidays: 'closed' | null = null;
  let exception = false; // a PH or date rule has been seen

  for (const rule of text.split(';').map((r) => r.trim()).filter(Boolean)) {
    if (/^ph\s*:?\s+(off|closed)$/.test(rule)) {
      holidays = 'closed';
      exception = true;
      continue;
    }
    const date = DATE_RULE.exec(rule);
    if (date) {
      const [, year, month, day, body] = date;
      const m = MONTHS[month];
      const d = Number(day);
      const probe = new Date(Date.UTC(year ? Number(year) : 2000, m - 1, d));
      if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) fail(rule, 'no such date');
      const md = `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const on = year ? `${year}-${md}` : `--${md}`;
      dates.set(on, isOff(body) ? { on, closed: true, spans: [] } : { on, closed: false, spans: merge(parseSpans(body, rule)) });
      exception = true;
      continue;
    }
    // As the Go parser: which of the two wins is ambiguous after an exception.
    if (exception) fail(rule, 'put weekday rules before PH and date rules');
    const withDays = WEEKDAYS_RULE.exec(rule);
    const body = withDays ? withDays[2] : rule;
    const selected = new Set<number>();
    if (withDays) {
      for (const part of withDays[1].split(',')) {
        const [a, b = a] = part.split('-').map((x) => DAYS[x.trim()]);
        for (let d = a; ; d = (d % 7) + 1) {
          selected.add(d);
          if (d === b) break;
        }
      }
    } else {
      for (let d = 1; d <= 7; d++) selected.add(d);
    }
    const spans = isOff(body) ? [] : parseSpans(body, rule);
    for (const d of selected) days[d] = spans; // a later rule for a day replaces the earlier one
  }

  const weekly: WeeklySpan[] = [];
  for (let d = 1; d <= 7; d++) for (const s of merge(days[d])) weekly.push({ d, ...s });
  // Rules that only close things say nothing about when a place is open.
  if (!weekly.length) throw new HoursTextError('no opening hours in that (a closed place is the "closed" button)');
  const schedule: Schedule = {
    v: 1,
    tz: 'America/New_York',
    always: false,
    weekly,
    dates: [...dates.values()].sort((a, b) => (a.on < b.on ? -1 : 1)),
    holidays,
    partial: 'none',
  };
  if (!validateSchedule(schedule)) throw new HoursTextError('that does not make a valid week');
  return schedule;
}
