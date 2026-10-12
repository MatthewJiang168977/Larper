"use client";

import { BlurFade } from "@/components/ui/blur-fade";
import { NumberTicker } from "@/components/ui/number-ticker";
import type { DeckItem, PlaceView, QuestView, Reasons } from "@/lib/api";
import { forwardRef } from "react";

export type QuestAction = "accept" | "skip" | "complete";

interface Props {
  quest: QuestView | null;
  deck: DeckItem[];
  selectedId: string | null;
  onSelect: (placeId: string) => void;
  onAction: (action: QuestAction) => void;
  busy: boolean;
}

const humanize = (s: string) => s.replaceAll("_", " ").replaceAll("-", " ");
const WALK_M_PER_MIN = 80;

// The bottom sheet: the focused place's field notes, links, and quest actions, with
// the other leads as a strip of numbered tabs matching their map pins.
export const QuestSheet = forwardRef<HTMLDivElement, Props>(function QuestSheet(
  { quest, deck, selectedId, onSelect, onAction, busy },
  ref,
) {
  const leadIndex = deck.findIndex((d) => d.place.id === selectedId);
  const focusedIsQuest = !!quest && (selectedId === null || selectedId === quest.place.id);
  const focused = focusedIsQuest ? quest : leadIndex >= 0 ? deck[leadIndex] : null;

  return (
    <section
      ref={ref}
      aria-label="Quest details"
      className="absolute inset-x-0 bottom-0 z-10 mx-auto max-w-xl rounded-t-2xl border-t border-x border-paper-edge bg-paper px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-6px_24px_rgba(43,41,37,0.12)]"
    >
      <div aria-hidden className="mx-auto mb-3 h-1 w-10 rounded-full bg-rule" />

      {deck.length > 0 && (
        <nav aria-label="Leads" className="-mx-5 mb-3 flex gap-2 overflow-x-auto px-5 pb-1">
          {quest && (
            <Tab active={focusedIsQuest} onClick={() => onSelect(quest.place.id)} seal>
              Quest
            </Tab>
          )}
          {deck.map((d, i) => (
            <Tab key={d.place.id} active={selectedId === d.place.id} onClick={() => onSelect(d.place.id)}>
              {i + 1}. {d.place.name}
            </Tab>
          ))}
        </nav>
      )}

      {focused ? (
        <BlurFade key={focused.place.id} duration={0.25} offset={4}>
          <PlaceNotes
            label={focusedIsQuest ? `Today's quest · ${quest!.status}` : `Lead ${leadIndex + 1}`}
            place={focused.place}
            reasons={focused.reasons}
          />
          <div className="mt-4 flex flex-wrap gap-2">
            {focusedIsQuest ? (
              <QuestButtons status={quest!.status} onAction={onAction} busy={busy} />
            ) : (
              <p className="text-sm text-ink-soft">
                A lead, not your quest. Skip today&apos;s quest and the best remaining lead takes its place.
              </p>
            )}
          </div>
        </BlurFade>
      ) : (
        <p className="py-6 text-center text-ink-soft">Nothing on the map yet.</p>
      )}
    </section>
  );
});

function Tab({
  active,
  onClick,
  seal,
  children,
}: {
  active: boolean;
  onClick: () => void;
  seal?: boolean;
  children: React.ReactNode;
}) {
  const tone = seal
    ? active
      ? "bg-oxblood text-paper border-oxblood"
      : "text-oxblood border-oxblood"
    : active
      ? "bg-ink text-paper border-ink"
      : "text-ink border-ink-faint";
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 max-w-[11rem] truncate rounded-full border px-3 py-1 font-mono text-xs ${tone}`}
    >
      {children}
    </button>
  );
}

function PlaceNotes({ label, place, reasons }: { label: string; place: PlaceView; reasons: Reasons }) {
  const walkMin = Math.max(1, Math.round(place.distanceM / WALK_M_PER_MIN));
  return (
    <div>
      <p className="field-label">{label}</p>
      <h2 className="mt-1 text-2xl font-semibold leading-tight [font-variation-settings:'opsz'_96]">{place.name}</h2>
      <p className="mt-1 text-ink-soft">
        {humanize(place.category)} ·{" "}
        <NumberTicker value={place.distanceM} className="text-ink-soft" /> m, about {walkMin} min on foot
      </p>

      <ul className="mt-3 space-y-1 border-l-2 border-rule pl-3 font-mono text-[0.8rem] text-ink">
        {reasons.liked.length > 0 && <li>You marked {reasons.liked.slice(0, 3).map(humanize).join(" + ")}.</li>}
        {reasons.rarest && (
          <li>
            {reasons.rarest.nearby <= 1
              ? `The only ${humanize(reasons.rarest.tag)} spot around here.`
              : `1 of ${reasons.rarest.nearby} ${humanize(reasons.rarest.tag)} spots around here.`}
          </li>
        )}
        {reasons.indie && <li>Independent. No other locations.</li>}
      </ul>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <a
          className="underline decoration-oxblood underline-offset-4"
          href={`https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}&travelmode=walking`}
          target="_blank"
          rel="noreferrer"
        >
          Directions
        </a>
        {place.website && (
          <a className="underline underline-offset-4" href={place.website} target="_blank" rel="noreferrer">
            Website
          </a>
        )}
        {place.instagram && (
          <a className="underline underline-offset-4" href={place.instagram} target="_blank" rel="noreferrer">
            Instagram
          </a>
        )}
        {place.phone && (
          <a className="underline underline-offset-4" href={`tel:${place.phone.replace(/[^\d+]/g, "")}`}>
            Call
          </a>
        )}
      </div>
      <p className="mt-2 text-xs text-ink-faint">No opening hours yet. Check before you go.</p>
    </div>
  );
}

function QuestButtons({
  status,
  onAction,
  busy,
}: {
  status: QuestView["status"];
  onAction: (a: QuestAction) => void;
  busy: boolean;
}) {
  const primary = "stamp-btn rounded-md bg-oxblood px-4 py-2 font-medium text-paper disabled:opacity-50";
  const secondary = "stamp-btn rounded-md bg-paper px-4 py-2 text-ink disabled:opacity-50";
  if (status === "offered") {
    return (
      <>
        <button className={primary} disabled={busy} onClick={() => onAction("accept")}>
          Accept quest
        </button>
        <button className={secondary} disabled={busy} onClick={() => onAction("skip")}>
          Skip
        </button>
      </>
    );
  }
  if (status === "accepted") {
    return (
      <>
        <button className={primary} disabled={busy} onClick={() => onAction("complete")}>
          I went
        </button>
        <button className={secondary} disabled={busy} onClick={() => onAction("skip")}>
          Abandon
        </button>
      </>
    );
  }
  return null;
}
