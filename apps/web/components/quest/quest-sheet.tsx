"use client";

import { animate, motion, useDragControls, useMotionValue, useReducedMotion, type PanInfo } from "motion/react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { BlurFade } from "@/components/ui/blur-fade";
import { NumberTicker } from "@/components/ui/number-ticker";
import type { DeckItem, PlaceView, QuestView, Reasons } from "@/lib/api";
import { fullHeight, offsetFor, resolveSnap, type Snap, snapForKey } from "./sheet-snap";

// "not-today" sets an accepted quest aside without counting against the place.
export type QuestAction = "accept" | "skip" | "not-today" | "complete";

interface Props {
  quest: QuestView | null;
  deck: DeckItem[];
  selectedId: string | null;
  onSelect: (placeId: string) => void;
  onAction: (action: QuestAction) => void;
  busy: boolean;
  /** Where the notices end, in px from the top: full stops below it. */
  topLimit: number;
  /** What the settled sheet covers, so fly-to keeps pins in the part you can see. */
  onCoveredChange: (c: Covered) => void;
}

/**
 * The map the sheet covers: its height at the bottom, or, open on a wide screen, the
 * width from its left edge to the right of the screen (pins then go in the strip of map
 * left of the centred card).
 */
export interface Covered {
  bottom: number;
  right: number;
}

/** On a screen with at least this much map either side of the open sheet, pins go beside it. */
export const SIDE_GUTTER_PX = 240;

const humanize = (s: string) => s.replaceAll("_", " ").replaceAll("-", " ");
const WALK_M_PER_MIN = 80;
const SPRING = { type: "spring", stiffness: 420, damping: 40 } as const;

// The focused place's field notes, links and quest actions, as a bottom sheet with two
// snaps: peek (name, distance, category and the main action) and full (everything,
// scrollable, stopping below the notices). The same sheet on every screen; on a wide one
// it's a card centred at the bottom, 60% of the screen (at most 960 px), sized to its
// content, and full lays out in two columns: the details, and the leads as a list.
export function QuestSheet(props: Props) {
  return <BottomSheet {...props} />;
}

function useFocused({ quest, deck, selectedId }: Pick<Props, "quest" | "deck" | "selectedId">) {
  const leadIndex = deck.findIndex((d) => d.place.id === selectedId);
  const isQuest = !!quest && (selectedId === null || selectedId === quest.place.id);
  const focused = isQuest ? quest : leadIndex >= 0 ? deck[leadIndex] : null;
  const label = isQuest ? `Today's quest · ${quest!.status}` : `Lead ${leadIndex + 1}`;
  return { focused, isQuest, label };
}

function BottomSheet(props: Props) {
  const { topLimit, onCoveredChange } = props;
  const { focused, isQuest, label } = useFocused(props);
  const reduce = useReducedMotion();
  const restId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const peekRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const restRef = useRef<HTMLDivElement>(null);
  const restContentRef = useRef<HTMLDivElement>(null);
  // Whether the current press turned into a drag: its release also fires a click, which
  // mustn't toggle the sheet a second time. (motion may end the drag a frame after that
  // click, so a timestamp from onDragEnd would be too late.)
  const pressDragged = useRef(false);
  const dragControls = useDragControls();
  const y = useMotionValue(0);
  const [snap, setSnap] = useState<Snap>("peek");
  const [peekH, setPeekH] = useState(0);
  const [restH, setRestH] = useState(0);
  const [viewH, setViewH] = useState(0);
  const [viewW, setViewW] = useState(0);
  const [sheetLeft, setSheetLeft] = useState(0);
  const [announce, setAnnounce] = useState("");
  // Full is as tall as its content, up to just below the notices (then it scrolls).
  const fullH = Math.min(fullHeight(viewH, topLimit, peekH), peekH + restH);
  const range = Math.max(0, fullH - peekH);

  // Measure peek (the visible part when collapsed) and the screen it sits on.
  useLayoutEffect(() => {
    const peek = peekRef.current;
    const host = sectionRef.current?.offsetParent as HTMLElement | null;
    if (!peek) return;
    const content = restContentRef.current;
    const measure = () => {
      setPeekH(peek.offsetHeight);
      setRestH(content?.offsetHeight ?? 0);
      setViewH(host?.clientHeight || window.innerHeight);
      setViewW(host?.clientWidth || window.innerWidth);
      setSheetLeft(sectionRef.current?.offsetLeft ?? 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(peek);
    if (content) ro.observe(content);
    if (host) ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // Rest at the current snap whenever it or the measurements change: animated on a snap
  // change, straight there on a resize (or always, with reduced motion). Before paint, so
  // the first frame isn't the sheet wide open.
  const lastSnap = useRef(snap);
  useLayoutEffect(() => {
    const to = offsetFor(snap, fullH, peekH);
    const changed = lastSnap.current !== snap;
    lastSnap.current = snap;
    if (changed && !reduce) {
      const a = animate(y, to, SPRING);
      return () => a.stop();
    }
    y.set(to);
  }, [snap, fullH, peekH, reduce, y]);

  // The map only hears about settled snaps. At peek: its height. Open on a wide screen:
  // the card's left edge, so a chosen pin lands in the map beside it, not behind it. Open
  // on a phone it keeps the peek inset: the map is mostly hidden then, and dropping back
  // to peek shouldn't jump.
  useEffect(() => {
    if (peekH <= 0) return;
    if (snap === "peek") onCoveredChange({ bottom: peekH, right: 0 });
    else if (sheetLeft >= SIDE_GUTTER_PX) onCoveredChange({ bottom: 0, right: viewW - sheetLeft + 24 });
  }, [snap, peekH, sheetLeft, viewW, onCoveredChange]);

  const go = useCallback(
    (next: Snap) => {
      setSnap(next);
      setAnnounce(next === "full" ? "Quest details expanded" : "Quest details collapsed");
      // Collapsing hides the rest: don't leave focus on something you can't see.
      if (next === "peek" && restRef.current?.contains(document.activeElement)) handleRef.current?.focus();
    },
    [],
  );

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const next = resolveSnap(y.get(), info.velocity.y, range, snap, info.offset.y);
    // Settle from wherever it was let go, even back to the snap it started at (the
    // snap effect only runs on a change, so it wouldn't move it).
    const to = offsetFor(next, fullH, peekH);
    if (reduce) y.set(to);
    else animate(y, to, SPRING);
    go(next);
  };

  return (
    <motion.section
      ref={sectionRef}
      aria-label="Quest details"
      drag="y"
      dragListener={false}
      dragControls={dragControls}
      dragConstraints={{ top: 0, bottom: range }}
      dragElastic={0.08}
      dragMomentum={false}
      onDragStart={() => (pressDragged.current = true)}
      onDragEnd={onDragEnd}
      onKeyDown={(e) => {
        if (e.key === "Escape" && snap === "full") {
          e.stopPropagation();
          go("peek");
          handleRef.current?.focus();
        }
      }}
      style={{ y, height: fullH || undefined }}
      data-snap={snap}
      className="absolute inset-x-0 bottom-0 z-10 mx-auto flex max-w-xl flex-col rounded-t-2xl lg:w-[60vw] lg:max-w-[960px] border-x border-t border-paper-edge bg-paper shadow-[0_-6px_24px_rgba(43,41,37,0.12)]"
    >
      <div ref={peekRef} className="shrink-0 px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {/* The handle strip: drag it, tap it, or use the keyboard on it. */}
        <button
          ref={handleRef}
          type="button"
          aria-expanded={snap === "full"}
          aria-controls={restId}
          aria-label={snap === "full" ? "Show less" : "Show more about this place"}
          aria-keyshortcuts="ArrowUp ArrowDown Home End"
          onPointerDown={(e) => {
            pressDragged.current = false;
            dragControls.start(e);
          }}
          onClick={(e) => {
            // A pointer press that dragged already settled the sheet. Keyboard clicks
            // (detail 0) always count, whatever an earlier drag left behind.
            if (e.detail !== 0 && pressDragged.current) return;
            go(snap === "peek" ? "full" : "peek");
          }}
          onKeyDown={(e) => {
            const next = snapForKey(e.key);
            if (next) {
              e.preventDefault();
              go(next);
            }
          }}
          className="-mx-5 flex h-11 w-[calc(100%+2.5rem)] touch-none items-center justify-center"
        >
          <span aria-hidden className="h-1 w-10 rounded-full bg-rule" />
        </button>
        {focused ? <Peek place={focused.place} label={label} {...props} isQuest={isQuest} /> : <Empty />}
      </div>

      <div
        ref={restRef}
        id={restId}
        inert={snap === "peek"}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5"
      >
        <div ref={restContentRef} className="pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {focused && <Rest {...props} focused={focused} isQuest={isQuest} />}
        </div>
      </div>

      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
    </motion.section>
  );
}

function Empty() {
  return <p className="py-6 text-center text-ink-soft">Nothing on the map yet.</p>;
}

// Peek: what you came for. The place, how far, and the one action that matters now.
function Peek({
  place,
  label,
  isQuest,
  quest,
  onAction,
  busy,
}: Props & { place: PlaceView; label: string; isQuest: boolean }) {
  const walkMin = Math.max(1, Math.round(place.distanceM / WALK_M_PER_MIN));
  return (
    <BlurFade key={place.id} duration={0.25} offset={4}>
      <p className="field-label">{label}</p>
      {/* The name gets the full width (two lines at most: names run long); the action
          sits beside the distance underneath. */}
      <h2 className="mt-1 line-clamp-2 text-2xl font-semibold leading-tight [font-variation-settings:'opsz'_96]">
        {place.name}
      </h2>
      <div className="mt-1 flex items-center gap-3">
        <p className="min-w-0 flex-1 text-ink-soft">
          {humanize(place.category)} · <NumberTicker value={place.distanceM} className="text-ink-soft" /> m, about{" "}
          {walkMin} min on foot
        </p>
        {isQuest && quest && (
          <div className="flex shrink-0 gap-2">
            <PrimaryAction status={quest.status} onAction={onAction} busy={busy} />
            {/* Wide screens: Skip / Not today beside it. Phones keep it in full. */}
            <SecondaryAction status={quest.status} onAction={onAction} busy={busy} className="hidden lg:inline-flex" />
          </div>
        )}
      </div>
    </BlurFade>
  );
}

// Full: the leads, why this place, its tags, the links, and the quieter action.
function Rest({
  quest,
  deck,
  selectedId,
  onSelect,
  onAction,
  busy,
  focused,
  isQuest,
}: Props & { focused: QuestView | DeckItem; isQuest: boolean }) {
  const { place, reasons } = focused;
  // Phones: the leads as one row that scrolls sideways, above the details. Wide screens:
  // two columns (about 55/45), the details on the left and the leads as a compact list
  // on the right, so full stays short with nothing to scroll.
  return (
    <div className="pt-1 lg:grid lg:grid-cols-[minmax(0,11fr)_minmax(0,9fr)] lg:gap-x-6">
      {deck.length > 0 && (
        // Wide screens: each row is ~44 px tall (two lines), so the rows' hit areas
        // don't overlap with only 2 px between them.
        <nav
          aria-label="Leads"
          className="-mx-5 flex gap-2 overflow-x-auto px-5 py-2.5 [scrollbar-color:var(--rule)_transparent] [scrollbar-width:thin] lg:col-start-2 lg:row-start-1 lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:px-0 lg:pt-1"
        >
          {quest && (
            <Tab
              active={isQuest}
              onClick={() => onSelect(quest.place.id)}
              seal
              label="Quest"
              marker={<FlagMark />}
              place={quest.place}
            />
          )}
          {deck.map((d, i) => (
            <Tab
              key={d.place.id}
              active={selectedId === d.place.id}
              onClick={() => onSelect(d.place.id)}
              label={`${i + 1}. ${d.place.name}`}
              marker={i + 1}
              place={d.place}
            />
          ))}
        </nav>
      )}

      <div className="lg:col-start-1 lg:row-start-1">
        <Why reasons={reasons} />
        {place.tags.length > 0 && (
          <p className="mt-3 font-mono text-xs text-ink-label">
            <span className="sr-only">Tags: </span>
            {place.tags.slice(0, 6).map(humanize).join(" · ")}
          </p>
        )}
        <Links place={place} />

        <div className={`mt-4 flex flex-wrap gap-2 ${isQuest ? "lg:hidden" : ""}`}>
          {isQuest && quest ? (
            // Wide screens show it in peek, beside the main action.
            <SecondaryAction status={quest.status} onAction={onAction} busy={busy} />
          ) : (
            <p className="text-sm text-ink-soft">
              A lead, not your quest. Skip today&apos;s quest and the best remaining lead takes its place.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Why({ reasons }: { reasons: Reasons }) {
  return (
    <ul
      aria-label="Why this place"
      className="mt-2 space-y-1 border-l-2 border-rule pl-3 font-mono text-[0.8rem] text-ink"
    >
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
  );
}

function Tab({
  active,
  onClick,
  seal,
  label,
  marker,
  place,
}: {
  active: boolean;
  onClick: () => void;
  seal?: boolean;
  /** The pill's text on phones, and the row's accessible name everywhere. */
  label: string;
  /** The row's number (or the quest's flag) on wide screens. */
  marker: React.ReactNode;
  place: PlaceView;
}) {
  const tone = seal
    ? active
      ? "bg-oxblood text-paper border-oxblood"
      : "text-oxblood border-oxblood"
    : active
      ? "bg-ink text-paper border-ink"
      : "text-ink border-ink-faint lg:hover:bg-rule/40";
  // Phones: a pill whose text truncates in its own span (overflow on the button would
  // clip its hit area; the strip's vertical padding leaves room for that hit area inside
  // its scroll box). Wide screens: a compact row with no border, the name (wrapping) over
  // its category and distance; the selected one stays filled.
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={`hit-target shrink-0 max-w-[11rem] rounded-full border px-3 py-1 font-mono text-xs lg:flex lg:w-full lg:max-w-full lg:items-start lg:gap-2 lg:rounded-md lg:border-0 lg:px-2 lg:py-1 lg:text-left lg:font-sans ${tone}`}
    >
      <span className="block truncate lg:hidden">{label}</span>
      <span aria-hidden className="hidden w-5 shrink-0 pt-0.5 text-right font-mono text-xs lg:block">
        {marker}
      </span>
      <span aria-hidden className="hidden min-w-0 flex-1 lg:block">
        <span className="block text-sm font-medium leading-snug">{place.name}</span>
        <span className="block truncate text-xs leading-snug opacity-75">
          {humanize(place.category)} · {formatDistance(place.distanceM)}
        </span>
      </span>
    </button>
  );
}

export function formatDistance(m: number) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

// The quest's mark in the lead list: the map pin's pennant, small.
function FlagMark() {
  return (
    <svg viewBox="0 0 24 24" className="ml-auto h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 21V3" />
      <path d="M6 4h11l-3 4.5 3 4.5H6" />
    </svg>
  );
}

// We have no opening hours (Overture has none), so link to a maps search for the place,
// centred on it so a same-name place elsewhere doesn't win. A plain link: no API call,
// nothing stored. The documented `?api=1&query=` form has no way to centre the search,
// and a visitor from out of town would get the nearest same-name place to them.
export function hoursSearchUrl(place: Pick<PlaceView, "name" | "lat" | "lng">) {
  return `https://www.google.com/maps/search/${encodeURIComponent(place.name)}/@${place.lat},${place.lng},18z`;
}

function Links({ place }: { place: PlaceView }) {
  return (
    <>
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
        <a className="underline underline-offset-4" href={hoursSearchUrl(place)} target="_blank" rel="noreferrer">
          Check hours
        </a>
      </div>
      <p className="mt-2 text-xs text-ink-label">No opening hours yet. Check before you go.</p>
    </>
  );
}

const PRIMARY = "stamp-btn shrink-0 rounded-md bg-oxblood px-4 py-2 font-medium text-paper disabled:opacity-50";
const SECONDARY = "stamp-btn rounded-md bg-paper px-4 py-2 text-ink disabled:opacity-50";

function PrimaryAction({ status, onAction, busy }: { status: QuestView["status"]; onAction: (a: QuestAction) => void; busy: boolean }) {
  if (status === "offered") {
    return (
      <button className={PRIMARY} disabled={busy} onClick={() => onAction("accept")}>
        Accept quest
      </button>
    );
  }
  if (status === "accepted") {
    return (
      <button className={PRIMARY} disabled={busy} onClick={() => onAction("complete")}>
        I went
      </button>
    );
  }
  return null;
}

function SecondaryAction({
  status,
  onAction,
  busy,
  className = "",
}: {
  status: QuestView["status"];
  onAction: (a: QuestAction) => void;
  busy: boolean;
  className?: string;
}) {
  if (status === "offered") {
    return (
      <button className={`${SECONDARY} ${className}`} disabled={busy} onClick={() => onAction("skip")}>
        Skip
      </button>
    );
  }
  if (status === "accepted") {
    return (
      <button className={`${SECONDARY} ${className}`} disabled={busy} onClick={() => onAction("not-today")}>
        Not today
      </button>
    );
  }
  return null;
}
