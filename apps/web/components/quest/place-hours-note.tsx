import type { ConfirmationRecency, HoursSource, OpenConfirmations, PlaceHours, PlaceView } from "@/lib/api";
import { ageDays, formatAge, formatClock, formatSpans } from "@/lib/format";
import { type KnownHours, readConfirmations, readHours } from "@/lib/hours";
import { telUrl, webUrl } from "@/lib/web-url";

/** Older than this, the hours get a "may be out of date" note. */
export const STALE_DAYS = 180;

const OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright";
const LINK = "hit-target underline underline-offset-4";

const SOURCES: Record<HoursSource, string> = {
  osm: "OpenStreetMap",
  website: "the venue's website",
  nyc_open_data: "NYC Open Data",
  alltheplaces: "AllThePlaces",
  manual: "checked by Larper",
};

const RECENCY: Record<ConfirmationRecency, string> = {
  this_week: "this week",
  this_month: "this month",
  a_while_ago: "a while ago",
};

function Source({ hours }: { hours: KnownHours }) {
  const label = Object.hasOwn(SOURCES, hours.source) ? SOURCES[hours.source] : null;
  const href = webUrl(hours.sourceUrl) ?? (hours.source === "osm" ? OSM_COPYRIGHT : null);
  // OpenStreetMap's licence asks for the credit to link to its copyright page (or the
  // object); the venue's website links to the page the hours came from.
  const linked = hours.source === "osm" || hours.source === "website" ? href : null;
  if (!label) return null;
  return linked ? (
    <a className={LINK} href={linked} target="_blank" rel="noreferrer">
      {label}
    </a>
  ) : (
    <>{label}</>
  );
}

/**
 * What we know about when a place is open, as plain text and links (no live region:
 * it's reference, not news). `now` is injected for tests. This only mounts on the client,
 * after the quest has loaded, so the relative times below never meet a server render.
 */
export function PlaceHoursNote({
  hours = { status: "unverified" },
  openConfirmations,
  website,
  phone,
  now = new Date(),
}: {
  hours?: PlaceHours;
  openConfirmations?: OpenConfirmations | null;
  website: PlaceView["website"];
  phone: PlaceView["phone"];
  now?: Date;
}) {
  const safe = readHours(hours);
  const confirmations = readConfirmations(openConfirmations);
  return (
    <div className="mt-4 space-y-1 text-sm text-ink-label" data-testid="place-hours">
      {safe.status === "known" ? <Known hours={safe} now={now} /> : <Unverified website={website} phone={phone} />}
      {confirmations && (
        <p>
          confirmed open by {confirmations.count} {confirmations.count === 1 ? "person" : "people"}, most
          recently {RECENCY[confirmations.last]}
        </p>
      )}
    </div>
  );
}

function Unverified({ website, phone }: Pick<PlaceView, "website" | "phone">) {
  const site = webUrl(website);
  const tel = telUrl(phone);
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
      <p>hours unverified, check before you go</p>
      {site && (
        <a className={LINK} href={site} target="_blank" rel="noreferrer">
          website
        </a>
      )}
      {tel && (
        <a className={LINK} href={tel}>
          call
        </a>
      )}
    </div>
  );
}

function Known({ hours, now }: { hours: KnownHours; now: Date }) {
  const { state, nextChange } = hours;
  // Tomorrow's change says so: "opens tomorrow 9 am", never a bare clock that reads as today.
  const clock = nextChange && formatClock(nextChange.at);
  const at = clock && nextChange?.day === "tomorrow" ? `tomorrow ${clock}` : clock;
  const right =
    state === "open"
      ? `open now${at && nextChange?.to === "closed" ? ` · closes ${at}` : ""}`
      : state === "closed"
        ? `closed now${at && nextChange?.to === "open" ? ` · opens ${at}` : ""}`
        : "hours may differ today, check before you go";
  const spans = formatSpans(hours.today);
  const today = spans || (hours.today.length === 0 && state === "closed" ? "closed today" : null);
  const age = hours.fetchedAt ? formatAge(hours.fetchedAt, now) : null;
  const days = hours.fetchedAt ? ageDays(hours.fetchedAt, now) : null;
  const manual = hours.source === "manual";
  const known = Object.hasOwn(SOURCES, hours.source);
  return (
    <>
      <p>{right}</p>
      {spans ? <p>today: {today}</p> : today && <p>{today}</p>}
      {hours.services.map((s) => {
        const text = formatSpans(s.today) || (s.today.length === 0 && s.state === "closed" ? "closed today" : null);
        return text && <p key={s.kind}>{s.kind}: {text}</p>;
      })}
      <p>
        {known && !manual && "from "}
        <Source hours={hours} />
        {age && ` · ${manual && known ? "" : "checked "}${age}`}
        {days !== null && days > STALE_DAYS && " · may be out of date"}
      </p>
    </>
  );
}
