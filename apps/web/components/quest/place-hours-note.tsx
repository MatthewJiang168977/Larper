import type { HoursSource, Weekday, OpenConfirmations, PlaceHours, PlaceView } from "@/lib/api";
import { ageDays, formatAge, formatClock, formatSpans } from "@/lib/format";

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

const DAYS: Record<Weekday, string> = {
  mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday", sun: "sunday",
};

// The API's link, but only a web address: it ends up in an href.
const webUrl = (url: string | null | undefined) => (url && /^https?:\/\//i.test(url) ? url : null);

function Source({ hours }: { hours: Extract<PlaceHours, { status: "known" }> }) {
  const label = SOURCES[hours.source] ?? null;
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
  return (
    <div className="mt-4 space-y-1 text-sm text-ink-label" data-testid="place-hours">
      {hours.status === "known" ? <Known hours={hours} now={now} /> : <Unverified website={website} phone={phone} />}
      {openConfirmations && openConfirmations.count > 0 && (
        <p>
          confirmed open by {openConfirmations.count} {openConfirmations.count === 1 ? "person" : "people"}, most
          recently {DAYS[openConfirmations.last.day] ?? openConfirmations.last.day} {openConfirmations.last.part}
        </p>
      )}
    </div>
  );
}

function Unverified({ website, phone }: Pick<PlaceView, "website" | "phone">) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
      <p>hours unverified, check before you go</p>
      {website && (
        <a className={LINK} href={website} target="_blank" rel="noreferrer">
          website
        </a>
      )}
      {phone && (
        <a className={LINK} href={`tel:${phone.replace(/[^\d+]/g, "")}`}>
          call
        </a>
      )}
    </div>
  );
}

function Known({ hours, now }: { hours: Extract<PlaceHours, { status: "known" }>; now: Date }) {
  const { state, nextChange } = hours;
  const right =
    state === "open"
      ? `open now${nextChange?.to === "closed" ? ` · closes ${formatClock(nextChange.at)}` : ""}`
      : state === "closed"
        ? `closed now${nextChange?.to === "open" ? ` · opens ${formatClock(nextChange.at)}` : ""}`
        : "hours may differ today, check before you go";
  const today = hours.today.length > 0 ? formatSpans(hours.today) : state === "closed" ? "closed today" : null;
  const age = formatAge(hours.fetchedAt, now);
  const days = ageDays(hours.fetchedAt, now);
  const manual = hours.source === "manual";
  const known = hours.source in SOURCES;
  return (
    <>
      <p>{right}</p>
      {hours.today.length > 0 ? <p>today: {today}</p> : today && <p>{today}</p>}
      {hours.services.map((s) => {
        const text = s.today.length > 0 ? formatSpans(s.today) : s.state === "closed" ? "closed today" : null;
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
