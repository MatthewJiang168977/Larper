// Opening hours, evaluated. A parser (the Go package in workers/internal/hours) turns a source's
// own text into the normalized schedule; the API only EVALUATES it, so what a place "is open"
// at an instant is decided here. Pure: the clock is a parameter, no dependencies.
//
// Canonical spec: workers/internal/hours/SCHEDULE.md (the Go code, StateAt, SpansOn, Validate,
// is the source of truth). Vectors: workers/internal/hours/testdata/vectors.json, copied
// verbatim to apps/api/src/hours/testdata/vectors.json: keep the two files identical.
// Every key is always present in Go's output; this reader also takes a missing weekly, dates,
// always or holidays as empty/false/null, as Go's decoder does.
//
// Missing or invalid hours are UNKNOWN, never closed: stateAt(null, ...) is 'unknown'.
// DST is by wall clock: every question is asked of the local date and minutes-of-day of the
// instant.

export type Holidays = 'closed' | 'open' | null;
export type PartialMode = 'none' | 'additive' | 'restrictive';
export interface Span {
  from: number;
  to: number;
}
export interface WeeklySpan extends Span {
  d: number;
}
export interface DateRule {
  on: string;
  closed?: boolean;
  spans?: Span[];
}
export interface Schedule {
  v: 1;
  tz: string;
  always: boolean;
  weekly: WeeklySpan[];
  dates: DateRule[];
  holidays: Holidays;
  partial: PartialMode;
}
export type OpenState = 'open' | 'closed' | 'unknown';
export interface DisplaySpan {
  from: string;
  to: string;
  nextDay: boolean;
}
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export interface NextChange {
  /** "HH:MM" on the New York wall clock */
  at: string;
  /** the New York day `at` falls on, relative to the instant asked about */
  day: 'today' | 'tomorrow';
  /** that day's name, so a reader never has to work it out from a clock it might not share */
  weekday: Weekday;
  to: 'open' | 'closed';
}

const DAY = 1440;
const MINUTE_MS = 60_000;
/** The most dated exceptions a schedule may carry (a year's worth, leap day included). More is rejected as invalid. */
export const MAX_DATES = 366;

// --- validation ---------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isInt = (x: unknown, lo: number, hi: number): x is number =>
  typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;

const TIME_ZONE = 'America/New_York'; // the only zone (Go's Validate)

// Go's checkSpan: from 0..1439, to from+1..2880.
function validSpan(s: unknown): s is Span {
  return isObj(s) && isInt(s.from, 0, DAY - 1) && isInt(s.to, 1, 2 * DAY) && s.to > s.from;
}

// Spans of one day: each starts strictly after the previous one ends (touching spans are merged by the parser).
function validSpans(x: unknown): Span[] | null {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x)) return null;
  const out: Span[] = [];
  for (const s of x) {
    if (!validSpan(s)) return null;
    const prev = out[out.length - 1];
    if (prev && s.from <= prev.to) return null;
    out.push({ from: s.from, to: s.to });
  }
  return out;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function validOn(on: unknown): boolean {
  if (typeof on !== 'string') return false;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(on);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
  }
  m = /^--(\d{2})-(\d{2})$/.exec(on);
  if (m) {
    const [mo, d] = [Number(m[1]), Number(m[2])];
    return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(2000, mo); // --02-29 is allowed
  }
  return false;
}

/**
 * The schedule if `json` is one Go's Validate accepts (what its MarshalJSON emits), else null,
 * which callers treat as no schedule at all.
 */
export function validateSchedule(json: unknown): Schedule | null {
  if (!isObj(json) || json.v !== 1 || json.tz !== TIME_ZONE) return null;
  if (json.partial !== 'none' && json.partial !== 'additive' && json.partial !== 'restrictive') return null;
  const always = json.always === undefined ? false : json.always;
  if (typeof always !== 'boolean') return null;
  const holidays = json.holidays === undefined ? null : json.holidays;
  if (!(holidays === null || holidays === 'closed' || holidays === 'open')) return null;
  const rawWeekly = json.weekly ?? [];
  const rawDates = json.dates ?? [];
  if (!Array.isArray(rawWeekly) || !Array.isArray(rawDates)) return null;
  if (rawDates.length > MAX_DATES) return null; // checked before any entry is read, so a huge list costs nothing
  if (always && (rawWeekly.length > 0 || rawDates.length > 0 || holidays !== null)) return null;

  const weekly: WeeklySpan[] = [];
  for (const w of rawWeekly) {
    if (!isObj(w) || !isInt(w.d, 1, 7) || !validSpan(w)) return null;
    const prev = weekly[weekly.length - 1];
    if (prev && (w.d < prev.d || (w.d === prev.d && w.from <= prev.to))) return null; // sorted by (d, from), no overlap or touch
    weekly.push({ d: w.d, from: w.from as number, to: w.to as number });
  }

  const dates: DateRule[] = [];
  for (const r of rawDates) {
    if (!isObj(r) || !validOn(r.on)) return null;
    const prev = dates[dates.length - 1];
    if (prev && (r.on as string) <= prev.on) return null; // sorted by on, once each
    const closed = r.closed === undefined ? false : r.closed;
    if (typeof closed !== 'boolean') return null;
    const spans = validSpans(r.spans);
    if (!spans) return null;
    if (closed ? spans.length > 0 : spans.length === 0) return null; // closed has no spans; otherwise at least one
    dates.push({ on: r.on as string, closed, spans });
  }
  return { v: 1, tz: TIME_ZONE, always, weekly, dates, holidays, partial: json.partial };
}

// --- local time ---------------------------------------------------------------------

export interface LocalTime {
  y: number;
  m: number;
  d: number;
  /** minutes after local midnight, 0..1439 */
  min: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();
function formatFor(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    formats.set(tz, f);
  }
  return f;
}

/** The wall clock in `tz` at this instant. */
export function localTime(at: Date, tz: string): LocalTime {
  const get: Record<string, number> = {};
  for (const p of formatFor(tz).formatToParts(at)) if (p.type !== 'literal') get[p.type] = Number(p.value);
  return { y: get.year, m: get.month, d: get.day, min: (get.hour % 24) * 60 + get.minute }; // % 24: 'h23' never says 24; a guard for other engines
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

const addDays = ({ y, m, d }: Ymd, n: number): Ymd => {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
/** ISO weekday, 1 = Monday ... 7 = Sunday. */
export const isoWeekday = ({ y, m, d }: Ymd): number => new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const pad = (n: number) => String(n).padStart(2, '0');

function isMajorHoliday({ y, m, d }: Ymd): boolean {
  if (m === 1 && d === 1) return true;
  if (m === 7 && d === 4) return true;
  if (m === 12 && d === 25) return true;
  if (m === 11 && isoWeekday({ y, m, d }) === 4) return Math.ceil(d / 7) === 4; // Thanksgiving: the 4th Thursday
  return false;
}

// --- the spans that start on one local date ------------------------------------------

interface DayPlan {
  spans: Span[];
  /** a holiday with no stated rule (holidays null): venues often change hours then, so the day is in doubt */
  doubt: boolean;
}

// Go's spansStarting: a dates entry (the exact year first) wins; else a holiday is closed, in
// doubt (null), or the weekday's spans ("open"); else the weekday's spans.
function planFor(s: Schedule, day: Ymd): DayPlan {
  const full = `${day.y}-${pad(day.m)}-${pad(day.d)}`;
  const yearly = `--${pad(day.m)}-${pad(day.d)}`;
  const rule = s.dates.find((r) => r.on === full) ?? s.dates.find((r) => r.on === yearly);
  if (rule) return { spans: rule.closed ? [] : (rule.spans ?? []), doubt: false };
  let doubt = false;
  if (isMajorHoliday(day)) {
    if (s.holidays === 'closed') return { spans: [], doubt: false };
    if (s.holidays === null) doubt = true;
  }
  const wd = isoWeekday(day);
  return { spans: s.weekly.filter((w) => w.d === wd), doubt };
}

function applyPartial(s: Schedule, state: OpenState): OpenState {
  if (s.partial === 'restrictive') return 'unknown';
  if (s.partial === 'additive' && state === 'closed') return 'unknown';
  return state;
}

// Go's stateAtLocal. An open span that is not in doubt wins; otherwise doubt makes it unknown:
// today being an unstated holiday (at any minute), or yesterday being one with a span that
// reaches this minute.
function stateAtLocal(s: Schedule, t: LocalTime): OpenState {
  return applyPartial(s, rawStateAt(s, t));
}

function rawStateAt(s: Schedule, t: LocalTime): OpenState {
  if (s.always) return 'open';
  let open = false;
  let doubt = false;
  const today = planFor(s, t);
  if (today.doubt) doubt = true;
  else if (today.spans.some((sp) => sp.from <= t.min && t.min < sp.to)) open = true;
  const prev = planFor(s, addDays(t, -1));
  for (const sp of prev.spans) {
    if (sp.to > DAY && t.min < sp.to - DAY) {
      if (prev.doubt) doubt = true;
      else open = true;
    }
  }
  return open ? 'open' : doubt ? 'unknown' : 'closed';
}

/** Open, closed or unknown at this instant. No schedule is unknown, never closed. */
export function stateAt(schedule: Schedule | null, at: Date): OpenState {
  if (!schedule) return 'unknown';
  return stateAtLocal(schedule, localTime(at, schedule.tz));
}

const hhmm = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/**
 * The spans that start on the local date of `at`, for display (Go's SpansOn): the regular spans
 * even on a holiday nobody stated (use stateAt for what is known); a closed day is []. Midnight
 * at the end of the day is "24:00"; nextDay says the span ends the following day.
 */
export function spansOn(schedule: Schedule, at: Date): DisplaySpan[] {
  if (schedule.always) return [{ from: '00:00', to: '24:00', nextDay: false }];
  return planFor(schedule, localTime(at, schedule.tz)).spans.map((sp) => ({
    from: hhmm(sp.from),
    to: hhmm(sp.to > DAY ? sp.to - DAY : sp.to),
    nextDay: sp.to > DAY,
  }));
}

// Number the civil minutes as if the local clock were in UTC, so differences include midnight.
const civilMinute = ({ y, m, d, min }: LocalTime) => Date.UTC(y, m - 1, d) / MINUTE_MS + min;

/**
 * The first actual change between open and closed, through the same New York wall time
 * tomorrow. Returns null for always-open schedules, no change, or an unknown current or
 * next state.
 */
export function nextChange(schedule: Schedule, at: Date): NextChange | null {
  if (schedule.always) return null;
  const now = localTime(at, schedule.tz);
  const current = stateAtLocal(schedule, now);
  if (current === 'unknown') return null;

  const start = Math.floor(at.getTime() / MINUTE_MS);
  const civilStart = civilMinute(now);
  // In New York, the window can span up to 25 elapsed hours and at most one offset
  // change. Probe the endpoint and locate the jump only if needed, keeping Intl
  // formatting out of the minute-by-minute scan.
  const maxElapsed = DAY + 60;
  const shiftAt = (elapsed: number) =>
    civilMinute(localTime(new Date((start + elapsed) * MINUTE_MS), schedule.tz)) - civilStart - elapsed;
  const shift = shiftAt(maxElapsed);
  let cutover = maxElapsed + 1;
  if (shift !== 0) {
    let lo = 1;
    let hi = maxElapsed;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (shiftAt(mid) === 0) lo = mid + 1;
      else hi = mid;
    }
    cutover = lo;
  }

  const tomorrow = addDays(now, 1);
  const cutoff = now.min + DAY;
  for (let elapsed = 1; elapsed <= maxElapsed; elapsed++) {
    const wall = now.min + elapsed + (elapsed >= cutover ? shift : 0);
    if (wall > cutoff) break;
    const day = wall < DAY ? now : tomorrow;
    const min = wall % DAY;
    const state = stateAtLocal(schedule, { ...day, min });
    if (state !== current) {
      return state === 'unknown'
        ? null
        : { at: hhmm(min), day: wall < DAY ? 'today' : 'tomorrow', weekday: WEEKDAYS[isoWeekday(day) - 1], to: state };
    }
    if (wall === cutoff) break;
  }
  return null;
}
