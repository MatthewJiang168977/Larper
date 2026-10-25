"use client";

import { useId, useState } from "react";
import type { Located } from "@/hooks/use-location";

type Reason = NonNullable<Located["reason"]>;

// Why the map isn't where the user is, in the details behind the chip.
export const DEMO_REASONS: Record<Reason, string> = {
  waiting: "We couldn't find you yet.",
  denied: "Location is off for this site. Allow it in your browser's settings, then try again.",
  unavailable: "Your device couldn't get a location fix.",
  "no-gps": "This device has no location.",
  outside: "You're outside New York City, which is all this demo covers.",
};

// Asking the browser again only helps while it might still answer.
const canRetry = (reason: Reason) => reason !== "no-gps" && reason !== "outside";

// Hidden for the rest of the visit once dismissed. Storage can be blocked (private
// mode, site data off); then the dismissal lasts until the page reloads.
export const DISMISS_KEY = "larper:demo-notice-dismissed";
let dismissedInMemory = false;
function readDismissed() {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return dismissedInMemory;
  }
}
function saveDismissed() {
  try {
    sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    dismissedInMemory = true;
  }
}

interface Props {
  loc: Located;
  /** The shared demo account. Anyone else is never told about a "demo". */
  demo: boolean;
  onRetry: () => void;
  retrying: boolean;
}

// Shown whenever the map isn't where the user is, so a demo deck is never mistaken for
// their own neighborhood. One line ("DEMO · MIDTOWN · Use my location"); the reason is
// a tap away, and it can be put away for the visit.
export function DemoNotice({ loc, demo, onRetry, retrying }: Props) {
  const [hidden, setHidden] = useState(readDismissed);
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  if (hidden) return null;

  const spot = loc.spot ?? "Washington Square";
  const reason = loc.reason ?? "unavailable";
  const retry = canRetry(reason) && (
    <button
      onClick={onRetry}
      disabled={retrying}
      className="hit-target field-label whitespace-nowrap px-1.5 py-1.5 text-oxblood! underline underline-offset-2 disabled:opacity-50"
    >
      {retrying ? "Looking…" : "Use my location"}
    </button>
  );

  return (
    <div role="region" aria-label={demo ? "Demo area" : "Map area"} className="flex max-w-full flex-col items-start gap-1 self-start">
      <div className="flex max-w-full flex-wrap items-center rounded border border-rule bg-paper/95 shadow-sm">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={detailsId}
          className="hit-target field-label flex items-center gap-1 whitespace-nowrap py-1.5 pl-2 pr-1.5"
        >
          {demo ? `Demo · ${spot}` : spot}
          <span aria-hidden>{open ? "▴" : "▾"}</span>
        </button>
        {/* Open, the action moves into the details, under the reason. */}
        {!open && retry}
        <button
          onClick={() => {
            saveDismissed();
            setHidden(true);
          }}
          aria-label="Hide for this visit"
          className="hit-target ml-auto min-w-9 py-1 text-ink-soft"
        >
          ×
        </button>
      </div>
      {/* Always in the DOM, so aria-controls points at something. */}
      <div id={detailsId} hidden={!open} className="max-w-sm rounded border border-rule bg-paper/95 px-3 py-2 text-sm shadow-sm">
        <p>
          <span className="font-medium">
            {demo ? `You're exploring ${spot}, the demo's home base.` : `You're exploring ${spot}, not your own neighborhood.`}
          </span>{" "}
          {DEMO_REASONS[reason]}
        </p>
        {open && retry && <div className="-ml-2 mt-1">{retry}</div>}
      </div>
    </div>
  );
}
