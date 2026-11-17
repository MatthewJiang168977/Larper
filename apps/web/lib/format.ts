// "120 m", "2.8 km", "306 km": metres near the door, kilometres for the long misses, as
// the API writes them (apps/api/src/quests/checkin.ts formatDistance).
export function formatDistance(m: number) {
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 100_000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

// --- opening hours, for people ---------------------------------------------------

/**
 * "17:00" as "5 pm", "11:30" as "11:30 am", "00:00" and "24:00" as "midnight", "12:00" as
 * "noon". Anything that isn't an "HH:MM" is returned as it came.
 */
export function formatClock(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return hhmm;
  if (min === 0 && (h === 0 || h === 24)) return "midnight";
  if (min === 0 && h === 12) return "noon";
  const suffix = h % 24 < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${min === 0 ? "" : `:${m[2]}`} ${suffix}`;
}

/** "11 am–10 pm", "5 pm–2 am" (a span that runs past midnight reads the same way). */
export function formatSpan(span: { from: string; to: string }): string {
  return `${formatClock(span.from)}–${formatClock(span.to)}`;
}

/** "11 am–2 pm, 5 pm–10 pm". */
export function formatSpans(spans: { from: string; to: string }[]): string {
  return spans.map(formatSpan).join(", ");
}

const DAY_MS = 86_400_000;

/**
 * How long ago, in the coarsest honest words: "today", "yesterday", "3 days ago",
 * "2 weeks ago", "6 months ago". Null when `iso` isn't a date.
 */
export function formatAge(iso: string, now: Date): string | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const days = Math.floor((now.getTime() - then) / DAY_MS);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

/** Whole days since `iso`, or null when it isn't a date. */
export function ageDays(iso: string, now: Date): number | null {
  const then = Date.parse(iso);
  return Number.isNaN(then) ? null : Math.floor((now.getTime() - then) / DAY_MS);
}
