"use client";

import { UserButton, useUser } from "@clerk/nextjs";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { avatarInitialsAppearance } from "@/components/auth/clerk-appearance";
import { useLocation, type Located } from "@/hooks/use-location";
import { ApiError, describeError, useApi, type DeckItem, type Me, type QuestView, type SkipReason, type Today } from "@/lib/api";
import { DEMO_MIDTOWN, DEMO_SPOT } from "@/lib/demo-spot";
import { getPreciseFix } from "@/lib/precise-fix";
import { formatDistance } from "@/lib/format";
import { DemoNotice } from "./demo-notice";
import { type Covered, QuestSheet, type QuestAction, type SheetNote } from "./quest-sheet";

export const SURVEY_POLL_MS = 4000;

// A full page load on purpose: the location hook reads ?at= when the page starts.
const demoAreaUrl = () => new URL(`/?at=${DEMO_SPOT.lat},${DEMO_SPOT.lng}`, window.location.origin).href;
// An area's ingest takes about a minute (longer on a one-core VM). Past this, stop
// polling and say so: the ingest-worker may be down, and the API keeps reporting the
// area as pending while its job waits or retries.
export const SURVEY_MAX_MS = 3 * 60_000;

// The shared demo account (Me.demo) never sits on an empty map: when the visitor's
// own position can't give a deck (location off or unavailable, or outside the demo
// region), it goes to Midtown, and the notice says why. A ?at= override is kept.
export function demoAccountLocation(loc: Located | null, outside: boolean): Located | null {
  if (!loc || loc.source === "override") return loc;
  const reason = loc.source === "demo" ? loc.reason : outside ? "outside" : null;
  return reason ? { ...DEMO_MIDTOWN, source: "demo", reason, spot: "Midtown" } : loc;
}

// Clerk's avatar is a 28 px button; this gives it the same 44 px hit area as everything else.
export const USER_BUTTON_APPEARANCE = { elements: { userButtonTrigger: "hit-target" } };

// Plus ink initials in place of Clerk's generated avatar, for a user with no photo.
export function userButtonAppearance(user: Parameters<typeof avatarInitialsAppearance>[0]) {
  const initials = avatarInitialsAppearance(user);
  return initials ? { elements: { ...USER_BUTTON_APPEARANCE.elements, ...initials.elements } } : USER_BUTTON_APPEARANCE;
}

// After "Not today", one optional tap says why. Only "Not my thing" counts against the
// place's kind of spot (the usual skip penalty); the rest are just recorded.
export const SKIP_REASONS: { reason: SkipReason; label: string }[] = [
  { reason: "not_my_thing", label: "Not my thing" },
  { reason: "too_far", label: "Too far" },
  { reason: "not_today", label: "Not today" },
  { reason: "closed", label: "Closed" },
];

// WebGL map: client only, and loaded after the shell so first paint isn't blocked on it.
const QuestMap = dynamic(() => import("@/components/map/maplibre-quest-map"), { ssr: false });

export function QuestHome() {
  const api = useApi();
  const { user } = useUser();
  const userButton = useMemo(
    () => ({ appearance: userButtonAppearance(user), userProfileProps: { appearance: avatarInitialsAppearance(user) } }),
    [user],
  );
  const { loc: located, retry: retryLocation, retrying: locating } = useLocation();
  const [me, setMe] = useState<Me | null>(null);
  // The demo account's GPS position turned out to be outside the demo region.
  const [outside, setOutside] = useState(false);
  const loc = useMemo(
    () => (me?.demo ? demoAccountLocation(located, outside) : located),
    [me?.demo, located, outside],
  );
  const [meError, setMeError] = useState<unknown>(null);
  const [meTries, setMeTries] = useState(0);
  const [today, setToday] = useState<Today | null>(null);
  const [todayError, setTodayError] = useState<unknown>(null);
  // Which request the latest answer (or failure) belongs to: anything else is in flight.
  const [answered, setAnswered] = useState<string | null>(null);
  const [surveyStart, setSurveyStart] = useState<number | null>(null);
  const [surveyOverdue, setSurveyOverdue] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The quest just checked in. The sheet stays on it for the rest of the visit (one quest
  // a day), whatever the next refresh offers: the API keeps a real account on it until
  // midnight anyway, but offers the shared demo account a new one straight away.
  const [finished, setFinished] = useState<QuestView | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<{ text: string; retry: (() => void) | null } | null>(null);
  const [fixing, setFixing] = useState(false);
  // The last check-in's result, shown in the sheet beside "I went".
  const [checkIn, setCheckIn] = useState<SheetNote | null>(null);
  // The quest just set aside with "Not today", while its reasons are on offer.
  const [setAside, setSetAside] = useState<string | null>(null);
  // What the bottom sheet or card covers, so fly-to keeps pins in view.
  const [covered, setCovered] = useState<Covered>({ bottom: 280, right: 0 });
  const onCoveredChange = useCallback(
    (c: Covered) => setCovered((p) => (p.bottom === c.bottom && p.right === c.right ? p : c)),
    [],
  );
  const [reloads, setReloads] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);
  // The top bar: the notices start below it, however many lines it wraps to. The map's
  // buttons go in its second slot.
  const headerRef = useRef<HTMLElement>(null);
  const [noticesTop, setNoticesTop] = useState(64);
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
  // Where the notices end: the quest sheet's full height stops below them.
  const noticesRef = useRef<HTMLDivElement>(null);
  const [noticesBottom, setNoticesBottom] = useState(64);

  useEffect(() => {
    api<Me>("/me").then(
      (m) => {
        setMe(m);
        setMeError(null);
      },
      setMeError,
    );
  }, [api, meTries]);

  // Refetch on a new location, after an action, a retry or a survey poll. `stale` drops
  // a slow response for an old location that lands after a newer one.
  // Keyed on the coordinates, not the object: a new note (e.g. a location retry that
  // ends on the same demo spot) is not a new place.
  const lat = loc?.lat;
  const lng = loc?.lng;
  const request = lat !== undefined && me?.onboarded ? `${lat},${lng}#${reloads}` : null;
  const loading = request !== null && answered !== request;
  useEffect(() => {
    if (lat === undefined || !me?.onboarded) return;
    const key = `${lat},${lng}#${reloads}`;
    let stale = false;
    api<Today>(`/quests/today?lat=${lat}&lng=${lng}`).then(
      (t) => {
        if (stale) return;
        // The demo account outside the demo region, with nothing loaded here: Midtown
        // instead (demoAccountLocation), and this empty answer is never shown.
        const empty = !t.quest && !t.deck.length && !(t.surveying?.pending.length ?? 0);
        if (me?.demo && loc?.source === "gps" && empty && (t.surveying?.outside?.length ?? 0) > 0) {
          setOutside(true);
          return;
        }
        setToday(t);
        setSelectedId(t.quest?.place.id ?? t.deck[0]?.place.id ?? null);
        setTodayError(null);
        const pending = (t.surveying?.pending.length ?? 0) > 0;
        setSurveyStart((s) => (pending ? (s ?? Date.now()) : null));
        if (!pending) setSurveyOverdue(false);
        setAnswered(key);
      },
      (e: unknown) => {
        if (stale) return;
        setTodayError(e);
        setAnswered(key);
      },
    );
    return () => {
      stale = true;
    };
    // loc and me.demo only matter with new coordinates or a new account, both deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, lat, lng, me?.onboarded, reloads]);

  // While areas are being surveyed, check back until the ingest-worker finishes. Every
  // finished request, failed or not, schedules the next check, up to SURVEY_MAX_MS.
  // After a 429 the next check waits as long as the API asked.
  const surveying = (today?.surveying?.pending.length ?? 0) > 0;
  const pollDelay =
    todayError instanceof ApiError && todayError.retryAfterS
      ? Math.max(SURVEY_POLL_MS, todayError.retryAfterS * 1000)
      : SURVEY_POLL_MS;
  useEffect(() => {
    if (!surveying || surveyOverdue || loading) return;
    const t = setTimeout(() => {
      if (surveyStart !== null && Date.now() - surveyStart > SURVEY_MAX_MS) setSurveyOverdue(true);
      else setReloads((n) => n + 1);
    }, pollDelay);
    return () => clearTimeout(t);
  }, [surveying, surveyOverdue, loading, surveyStart, answered, pollDelay]);

  // The fixed cards (errors, surveying) report their height here; the quest sheet
  // reports its own settled height through onCoveredChange.
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onCoveredChange({ bottom: el.offsetHeight, right: 0 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [today, todayError, meError, onCoveredChange]);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const measure = () => setNoticesTop(el.offsetTop + el.offsetHeight + 8);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = noticesRef.current;
    if (!el) return;
    const measure = () => setNoticesBottom(el.offsetTop + el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const reload = () => setReloads((n) => n + 1);
  const retryMe = () => {
    setMeError(null);
    setMeTries((n) => n + 1);
  };
  const keepSurveying = () => {
    setSurveyOverdue(false);
    setSurveyStart(Date.now());
    reload();
  };

  const act = async (action: QuestAction) => {
    if (!today?.quest) return;
    const quest = today.quest;
    const questId = quest.id;
    const placeName = quest.place.name;
    setBusy(true);
    setActionError(null);
    setCheckIn(null);
    setSetAside(null);
    try {
      // Checking in sends where you are; the API only accepts it near the place. The
      // map's position can be stale or coarse, so take one fresh, precise reading
      // first (not for a ?at= override: that's the position on purpose).
      let body: { lat: number; lng: number; accuracy?: number } | undefined;
      if (action === "complete") {
        let fix = null;
        if (loc?.source !== "override") {
          setFixing(true);
          fix = await getPreciseFix();
          setFixing(false);
        }
        const at = fix ?? (loc ? { lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM } : null);
        if (at) body = { lat: at.lat, lng: at.lng, accuracy: at.accuracyM };
      }
      const res = await api<{ simulated?: boolean; distanceM?: number } | null>(`/quests/${questId}/${action}`, {
        method: "POST",
        body: body && JSON.stringify(body),
      });
      if (action === "not-today") setSetAside(questId);
      if (action === "complete") {
        setCheckIn(checkedIn(placeName, res));
        setFinished({ ...quest, status: "completed" });
      }
      reload();
    } catch (e) {
      // A rejected check-in (too far, or a fix too rough to tell) shows in the sheet, by
      // "I went", and is worth another go after a few steps or with precise location on.
      if (action === "complete" && e instanceof ApiError && e.status === 422) {
        setCheckIn({
          tone: "rejected",
          label: "Not checked in",
          text: describeError(e),
          action: { label: "Check again", onClick: () => act("complete") },
        });
      } else {
        setActionError({ text: describeError(e), retry: null });
      }
    } finally {
      setFixing(false);
      setBusy(false);
    }
  };

  const giveReason = async (reason: SkipReason) => {
    if (!setAside) return;
    setBusy(true);
    try {
      await api(`/quests/${setAside}/reason`, { method: "POST", body: JSON.stringify({ reason }) });
    } catch (e) {
      setActionError({ text: describeError(e), retry: null });
    } finally {
      setSetAside(null);
      setBusy(false);
    }
  };

  if (me && !me.onboarded) {
    return (
      <Centered>
        <p className="field-label">New field journal</p>
        <h1 className="text-3xl font-semibold">First, what are you into?</h1>
        <p className="max-w-sm text-ink-soft">Swipe through a few vibes so the quests fit you.</p>
        <Link href="/onboarding" className="stamp-btn rounded-md bg-oxblood px-5 py-2 text-paper">
          Set your vibes
        </Link>
      </Centered>
    );
  }

  // What the map and the sheet show: the finished quest alone, or today's quest and leads.
  const quest = finished ?? today?.quest ?? null;
  const deck: DeckItem[] = finished ? [] : (today?.deck ?? []);
  const selected = finished ? null : selectedId;

  // A failed refresh while a deck is already on screen: keep the deck, say so above it.
  const banner = actionError
    ? { text: actionError.text, retry: actionError.retry, label: "Try again", pending: busy }
    : today && todayError
      ? { text: describeError(todayError), retry: reload, label: "Retry", pending: loading }
      : null;

  return (
    <main className="relative h-dvh w-full overflow-hidden">
      {loc && <QuestMap
        me={loc}
        quest={quest}
        deck={deck}
        selectedId={selected}
        onSelect={setSelectedId}
        bottomInset={covered.bottom}
        rightInset={covered.right}
        controlsHost={controlsHost}
      />}

      {/* The pill and the map's buttons side by side, or the buttons on a second line
          (right-aligned) when both don't fit: large text, zoom, a narrow screen. */}
      <header
        ref={headerRef}
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-wrap items-start justify-between gap-2 px-3 pt-3"
      >
        {/* Wraps too, at the narrowest (200% zoom on a phone): rounded-3xl looks the same as
            rounded-full on one line and stays a card on two. */}
        <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-x-3 rounded-3xl border border-paper-edge bg-paper/90 py-1 pl-4 pr-1 shadow-sm backdrop-blur">
          <span className="text-lg font-semibold tracking-tight">Larper</span>
          <Link
            href="/journal"
            className="hit-target font-mono text-xs uppercase tracking-wider text-ink-soft underline-offset-4 hover:underline"
          >
            Journal
          </Link>
          <UserButton {...userButton} />
        </div>
        <div ref={setControlsHost} data-testid="map-controls" className="pointer-events-auto ml-auto" />
      </header>

      {/* Notices under the header, stacked so they never overlap. They stop above the
          sheet (or whatever card covers the bottom) and scroll if they don't fit, so they
          never cover the place or its action. */}
      <div
        ref={noticesRef}
        data-testid="notices"
        style={{ top: noticesTop, maxHeight: `calc(100% - ${noticesTop + covered.bottom + 8}px)` }}
        className="pointer-events-none absolute inset-x-3 z-20 flex flex-col items-center gap-2 overflow-y-auto overscroll-contain [&>*]:pointer-events-auto [&>*]:shrink-0"
      >
        {loc?.source === "demo" ? (
          <DemoNotice loc={loc} demo={!!me?.demo} onRetry={retryLocation} retrying={locating} />
        ) : (
          loc?.note && <p className="field-label self-start rounded bg-paper/90 px-2 py-1">{loc.note}</p>
        )}

        {fixing && (
          <p role="status" className="field-label animate-pulse rounded border border-rule bg-paper/95 px-3 py-1.5">
            Getting a precise fix…
          </p>
        )}

        {surveying && (
          <p
            role="status"
            className={`field-label rounded border border-rule bg-paper/95 px-3 py-1.5 ${surveyOverdue ? "" : "animate-pulse"}`}
          >
            {surveyOverdue ? "Still surveying" : "Surveying the area…"} mapping {today!.surveying!.pending.length} new{" "}
            {today!.surveying!.pending.length === 1 ? "district" : "districts"}
          </p>
        )}

        {setAside && (
          <div role="region" aria-label="Why not today?" className="w-full rounded border border-rule bg-paper/95 px-3 py-2 text-sm">
            <div className="flex items-center gap-3">
              <p className="flex-1">
                <span className="font-medium">Set aside for today.</span> Want to say why? It&apos;s optional.
              </p>
              <button onClick={() => setSetAside(null)} aria-label="No reason" className="hit-target px-1">
                ×
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {SKIP_REASONS.map(({ reason, label }) => (
                <button
                  key={reason}
                  onClick={() => giveReason(reason)}
                  disabled={busy}
                  className="min-h-11 rounded-full border border-paper-edge bg-paper px-4 disabled:opacity-50"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {banner && (
          <div
            role="alert"
            className="flex w-full items-center gap-3 rounded border border-oxblood bg-paper px-3 py-2 text-sm text-oxblood"
          >
            <p className="flex-1">{banner.text}</p>
            {banner.retry && (
              <button onClick={banner.retry} disabled={banner.pending} className="font-medium underline disabled:opacity-50">
                {banner.pending ? "Retrying…" : banner.label}
              </button>
            )}
            <button
              onClick={() => (actionError ? setActionError(null) : setTodayError(null))}
              aria-label="Dismiss"
              className="hit-target px-1"
            >
              ×
            </button>
          </div>
        )}
      </div>

      {!loc ? (
        <BottomLabel>Finding you…</BottomLabel>
      ) : meError && !me ? (
        <Panel
          ref={sheetRef}
          label="Couldn't load your journal"
          body={describeError(meError)}
          action={{ text: "Retry", onClick: retryMe }}
        />
      ) : !today && todayError ? (
        <Panel
          ref={sheetRef}
          label="Couldn't load your quest"
          body={describeError(todayError)}
          action={{ text: loading ? "Retrying…" : "Retry", onClick: reload, disabled: loading }}
        />
      ) : !today ? (
        <BottomLabel>Loading your quest…</BottomLabel>
      ) : surveying && !today.deck.length && quest?.status !== "completed" ? (
        surveyOverdue ? (
          <Panel
            ref={sheetRef}
            label="Taking longer than usual"
            body="This area is still being surveyed. Check again in a bit, or try somewhere else."
            action={{ text: "Check again", onClick: keepSurveying }}
          />
        ) : (
          <Panel
            ref={sheetRef}
            label="Uncharted territory"
            body="Nobody's mapped this area yet. Surveying it now; your quest appears here in a minute or so."
          />
        )
      ) : !quest && !deck.length && (today.surveying?.outside?.length ?? 0) > 0 && !surveying ? (
        // Nothing loaded here, and the API won't load it: the public demo covers one city.
        <Panel
          ref={sheetRef}
          label="Outside the demo area"
          body="This demo covers New York City. Try it from Washington Square instead."
          action={{ text: "Go to the demo area", onClick: () => window.location.assign(demoAreaUrl()) }}
        />
      ) : quest || deck.length ? (
        <QuestSheet
          quest={quest}
          deck={deck}
          selectedId={selected}
          onSelect={setSelectedId}
          onAction={act}
          busy={busy}
          topLimit={noticesBottom}
          onCoveredChange={onCoveredChange}
          note={checkIn && checkIn.action ? { ...checkIn, action: { ...checkIn.action, pending: busy } } : checkIn}
          onDismissNote={() => setCheckIn(null)}
          demo={me?.demo}
        />
      ) : (
        <Panel
          ref={sheetRef}
          label="Uncharted"
          body={
            today.surveying?.failed.length
              ? "Couldn't survey this area just now. Try again in a bit."
              : "Nothing quest-worthy within reach here. Try somewhere livelier."
          }
          action={{ text: loading ? "Checking…" : "Try again", onClick: reload, disabled: loading }}
        />
      )}
    </main>
  );
}

// What a successful check-in says. The shared demo account checks in from anywhere (its
// visitors are mostly far from the demo area); the API marks that one simulated, and so
// does this, plainly.
export function checkedIn(place: string, res: { simulated?: boolean; distanceM?: number } | null): SheetNote {
  if (res?.simulated) {
    const away = res.distanceM !== undefined ? `You're ${formatDistance(res.distanceM)} from ${place}, so` : "You're not at the door, so";
    return {
      tone: "simulated",
      label: "Simulated check-in · demo account",
      text: `${away} the demo pretended you arrived. With your own account, you check in at the door.`,
    };
  }
  return { tone: "done", label: "Checked in", text: `${place} is in your journal.` };
}

function BottomLabel({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="field-label absolute inset-x-0 bottom-8 z-10 text-center">
      {children}
    </p>
  );
}

interface PanelProps {
  label: string;
  body: string;
  action?: { text: string; onClick: () => void; disabled?: boolean };
  ref?: React.Ref<HTMLDivElement>;
}

// The bottom card for every state that isn't a quest: errors, surveying, nothing nearby.
function Panel({ label, body, action, ref }: PanelProps) {
  return (
    <div ref={ref} className="absolute inset-x-0 bottom-0 z-10 mx-auto max-w-xl rounded-t-2xl bg-paper p-5 text-center">
      <p className="field-label">{label}</p>
      <p className="mt-1 text-ink-soft">{body}</p>
      {action && (
        <button
          onClick={action.onClick}
          disabled={action.disabled}
          className="stamp-btn mt-3 rounded-md bg-oxblood px-4 py-2 text-paper disabled:opacity-50"
        >
          {action.text}
        </button>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">{children}</main>;
}
