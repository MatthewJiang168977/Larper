import type { ConfirmationRecency, HoursSpan, OpenConfirmations, PlaceHours, Weekday } from "./api";
import { formatClock } from "./format";

// The API's hours, made safe to render: whatever arrives that doesn't fit the contract is
// dropped, never thrown on. When in doubt, show less, and never "closed" unless it's
// known and exactly "closed".

export type KnownHours = Extract<PlaceHours, { status: "known" }>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const STATES = ["open", "closed", "unknown"] as const;
const KINDS = ["kitchen", "bar"] as const;
const DAYS: readonly string[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const RECENCY: readonly string[] = ["this_week", "this_month", "a_while_ago"];
/** The fewest people a confirmation is shown for; the API holds back fewer too (this is the second lock). */
export const MIN_CONFIRMATIONS = 3;

const span = (raw: unknown): HoursSpan | null =>
  isObject(raw) && formatClock(raw.from) && formatClock(raw.to)
    ? { from: raw.from as string, to: raw.to as string, nextDay: raw.nextDay === true }
    : null;
const spans = (raw: unknown): HoursSpan[] => (Array.isArray(raw) ? raw.flatMap((s) => span(s) ?? []) : []);

export function readHours(raw: unknown): PlaceHours {
  if (!isObject(raw) || raw.status !== "known") return { status: "unverified" };
  const state = STATES.find((s) => s === raw.state) ?? "unknown";
  const change = isObject(raw.nextChange) ? raw.nextChange : null;
  const nextChange =
    change &&
    formatClock(change.at) &&
    (change.to === "open" || change.to === "closed")
      ? {
          at: change.at as string,
          to: change.to as "open" | "closed",
          // Without a valid day AND weekday (an older API), the time is shown bare, as before.
          ...((change.day === "today" || change.day === "tomorrow") && DAYS.includes(change.weekday as string)
            ? { day: change.day as "today" | "tomorrow", weekday: change.weekday as Weekday }
            : {}),
        }
      : null;
  const services = Array.isArray(raw.services)
    ? raw.services.flatMap((s) => {
        const kind = isObject(s) ? KINDS.find((k) => k === s.kind) : undefined;
        return isObject(s) && kind
          ? [{ kind, state: STATES.find((x) => x === s.state) ?? "unknown", today: spans(s.today) }]
          : [];
      })
    : [];
  return {
    status: "known",
    state,
    today: spans(raw.today),
    nextChange,
    // An unknown source is kept as it came: the note then names none.
    source: raw.source as KnownHours["source"],
    sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : null,
    fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : "",
    services,
  };
}

export function readConfirmations(raw: unknown): OpenConfirmations | null {
  if (!isObject(raw) || !Number.isInteger(raw.count) || (raw.count as number) < MIN_CONFIRMATIONS) return null;
  if (!RECENCY.includes(raw.last as string)) return null; // an older API's day-and-part object is dropped, not shown
  return { count: raw.count as number, last: raw.last as ConfirmationRecency };
}
