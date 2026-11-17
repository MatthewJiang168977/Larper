// Opening hours, evaluated. A parser (another package) turns a source's own text into the
// normalized schedule below; the API only EVALUATES it, so what a place "is open" at an
// instant is decided in this one file. Pure: the clock is a parameter, no dependencies.
//
// Schedule v1 (JSON, as stored in place_hours_facts.schedule):
//   { "v": 1, "tz": "America/New_York", "always": false,
//     "weekly": [ { "d": 1, "from": 540, "to": 1020 } ],
//     "dates":  [ { "on": "2026-12-25", "closed": true }, { "on": "--12-24", "spans": [ { "from": 540, "to": 900 } ] } ],
//     "holidays": null, "partial": "none" }
//
//  - d: ISO weekday (1 = Mon ... 7 = Sun), the local day a span STARTS on. from: minutes after
//    local midnight, 0..1439. to: from + 1 .. 2880; above 1440 it runs past midnight into the
//    next day. Several spans a day are split shifts: sorted, not overlapping.
//  - always: open 24/7.
//  - dates: overrides for the local date a span starts on ("YYYY-MM-DD", or "--MM-DD" every
//    year; a specific year beats the yearly one). Either closed: true or spans. They replace the
//    weekly spans that START that date; the previous day's overnight span still applies.
//  - holidays: what happens on a major US holiday (Jan 1, Jul 4, Thanksgiving, Dec 25) that has
//    no date override: "closed", "open" (the weekly rule applies), or null (not stated: unknown).
//  - partial: whether the parser dropped rules it could not read. "additive": a dropped rule
//    could only add open time, so a computed "closed" becomes unknown. "restrictive": a dropped
//    rule could take open time away, so both open and closed become unknown.
//
// Missing or invalid hours are UNKNOWN, never closed: stateAt(null, ...) is 'unknown'.
// DST is by wall clock: every question is asked of the local date and minutes-of-day of the
// instant (on 2026-11-01 both 01:30 instants are minute 90; on 2026-03-08 02:xx never happens).

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
  closed?: true;
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
export interface NextChange {
  at: string;
  to: 'open' | 'closed';
}

const DAY = 1440;

// --- validation ---------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isInt = (x: unknown, lo: number, hi: number): x is number =>
  typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi;

function validSpans(x: unknown): Span[] | null {
  if (!Array.isArray(x) || x.length > 24) return null;
  const out: Span[] = [];
  for (const s of x) {
    if (!isObj(s) || !isInt(s.from, 0, DAY - 1) || !isInt(s.to, 1, 2 * DAY) || s.to <= s.from) return null;
    const prev = out[out.length - 1];
    if (prev && s.from < prev.to) return null; // sorted, not overlapping
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
    return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(2024, mo); // Feb 29 is a real yearly date
  }
  return false;
}

function validTz(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The schedule if `json` is a valid v1 schedule, else null (which callers treat as no schedule at all). */
export function validateSchedule(json: unknown): Schedule | null {
  if (!isObj(json) || json.v !== 1 || !validTz(json.tz) || typeof json.always !== 'boolean') return null;
  if (!(json.holidays === null || json.holidays === 'closed' || json.holidays === 'open')) return null;
  if (json.partial !== 'none' && json.partial !== 'additive' && json.partial !== 'restrictive') return null;

  if (!Array.isArray(json.weekly) || json.weekly.length > 7 * 24) return null;
  const weekly: WeeklySpan[] = [];
  const lastOnDay = new Map<number, WeeklySpan>();
  for (const w of json.weekly) {
    if (!isObj(w) || !isInt(w.d, 1, 7) || !isInt(w.from, 0, DAY - 1) || !isInt(w.to, 1, 2 * DAY) || w.to <= w.from) {
      return null;
    }
    const prev = lastOnDay.get(w.d);
    if (prev && w.from < prev.to) return null; // per day: sorted, not overlapping
    const span = { d: w.d, from: w.from, to: w.to };
    lastOnDay.set(w.d, span);
    weekly.push(span);
  }

  if (!Array.isArray(json.dates) || json.dates.length > 400) return null;
  const dates: DateRule[] = [];
  const seen = new Set<string>();
  for (const r of json.dates) {
    if (!isObj(r) || !validOn(r.on) || seen.has(r.on as string)) return null;
    seen.add(r.on as string);
    const hasClosed = 'closed' in r;
    const hasSpans = 'spans' in r;
    if (hasClosed === hasSpans) return null; // exactly one of the two
    if (hasClosed) {
      if (r.closed !== true) return null;
      dates.push({ on: r.on as string, closed: true });
    } else {
      const spans = validSpans(r.spans);
      if (!spans || spans.length === 0) return null;
      dates.push({ on: r.on as string, spans });
    }
  }
  return { v: 1, tz: json.tz, always: json.always, weekly, dates, holidays: json.holidays, partial: json.partial };
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
const dayNumber = ({ y, m, d }: Ymd): number => Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
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
  /** a holiday with no stated rule: nothing can be said about this day */
  unknown: boolean;
}

function planFor(s: Schedule, day: Ymd): DayPlan {
  const full = `${day.y}-${pad(day.m)}-${pad(day.d)}`;
  const yearly = `--${pad(day.m)}-${pad(day.d)}`;
  const rule = s.dates.find((r) => r.on === full) ?? s.dates.find((r) => r.on === yearly);
  if (rule) return { spans: rule.closed ? [] : (rule.spans ?? []), unknown: false };
  if (isMajorHoliday(day)) {
    if (s.holidays === 'closed') return { spans: [], unknown: false };
    if (s.holidays === null) return { spans: [], unknown: true };
  }
  const wd = isoWeekday(day);
  return { spans: s.weekly.filter((w) => w.d === wd), unknown: false };
}

function applyPartial(s: Schedule, state: OpenState): OpenState {
  if (state === 'unknown') return state;
  if (s.partial === 'restrictive') return 'unknown';
  if (s.partial === 'additive' && state === 'closed') return 'unknown';
  return state;
}

function stateAtLocal(s: Schedule, t: LocalTime): OpenState {
  if (s.always) return applyPartial(s, 'open');
  const yesterday = addDays(t, -1);
  const todayPlan = planFor(s, t);
  const prevPlan = planFor(s, yesterday);
  if (todayPlan.unknown) return 'unknown';
  // Yesterday's overnight tail is only at stake if yesterday has one. An unstated holiday
  // yesterday could have had one, so the early hours are unknown (the conservative reading).
  if (prevPlan.unknown && s.weekly.some((w) => w.d === isoWeekday(yesterday) && w.to > DAY)) return 'unknown';
  const open =
    todayPlan.spans.some((sp) => sp.from <= t.min && t.min < sp.to) ||
    prevPlan.spans.some((sp) => sp.to > DAY && t.min < sp.to - DAY);
  return applyPartial(s, open ? 'open' : 'closed');
}

/** Open, closed or unknown at this instant. No schedule is unknown, never closed. */
export function stateAt(schedule: Schedule | null, at: Date): OpenState {
  if (!schedule) return 'unknown';
  return stateAtLocal(schedule, localTime(at, schedule.tz));
}

const hhmm = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/** Today's spans (the local date of `at`) for display. A closed day, and a holiday nobody stated, are []. */
export function spansOn(schedule: Schedule, at: Date): DisplaySpan[] {
  if (schedule.always) return [{ from: '00:00', to: '00:00', nextDay: true }];
  const plan = planFor(schedule, localTime(at, schedule.tz));
  if (plan.unknown) return [];
  return plan.spans.map((sp) => ({ from: hhmm(sp.from), to: hhmm(sp.to % DAY), nextDay: sp.to >= DAY }));
}

/**
 * The next time within 24 hours of wall clock that the state changes between open and closed,
 * from the spans. null when there is none, the schedule is always open, or the state now (or
 * right after the change) is unknown.
 */
export function nextChange(schedule: Schedule, at: Date): NextChange | null {
  if (schedule.always) return null;
  const now = localTime(at, schedule.tz);
  const current = stateAtLocal(schedule, now);
  if (current === 'unknown') return null;
  const nowDay = dayNumber(now);

  // Every wall-clock moment a span starts or ends, as minutes from now, plus the next
  // midnight (where a date rule or a holiday can change the day).
  const offsets = new Set<number>([DAY - now.min]);
  for (let i = -1; i <= 1; i++) {
    const day = addDays(now, i);
    for (const sp of planFor(schedule, day).spans) {
      for (const edge of [sp.from, sp.to]) offsets.add((dayNumber(day) - nowDay) * DAY + edge - now.min);
    }
  }
  for (const off of [...offsets].filter((o) => o > 0 && o <= DAY).sort((a, b) => a - b)) {
    const absolute = now.min + off;
    const day = addDays(now, Math.floor(absolute / DAY));
    const state = stateAtLocal(schedule, { ...day, min: absolute % DAY });
    if (state === current) continue;
    return state === 'unknown' ? null : { at: hhmm(absolute % DAY), to: state };
  }
  return null;
}
