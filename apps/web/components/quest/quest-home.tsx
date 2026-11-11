"use client";

import { UserButton, useUser } from "@clerk/nextjs";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { avatarInitialsAppearance } from "@/components/auth/clerk-appearance";
import { useLocation, type Located } from "@/hooks/use-location";
import { type CheckinResult, questProps, setDemo, track } from "@/lib/analytics";
import { ApiError, describeError, useApi, type DeckItem, type Me, type QuestView, type SkipReason, type Today } from "@/lib/api";
import { DEMO_MIDTOWN, DEMO_SPOT } from "@/lib/demo-spot";
import { getPreciseFix } from "@/lib/precise-fix";
import { formatDistance } from "@/lib/format";
import { DemoNotice } from "./demo-notice";
import { StateCard } from "./state-card";
import { type Covered, QuestSheet, type QuestAction, type SheetNote } from "./quest-sheet";
import type { Snap } from "./sheet-snap";

export const SURVEY_POLL_MS = 4000;

// A full page load on purpose: the location hook reads ?at= when the page starts.
const atUrl = (p: { lat: number; lng: number }) => new URL(`/?at=${p.lat},${p.lng}`, window.location.origin).href;
const demoAreaUrl = () => atUrl(DEMO_SPOT);
// Where "nothing here" and "outside New York City" send a real account: Midtown is dense
// and loaded, so it always has quests.
const seeMidtown = { text: "See Midtown's quests", onClick: () => window.location.assign(atUrl(DEMO_MIDTOWN)) };
// Already there (the demo account's fallback, or ?at= Midtown): no point offering it.
export const isMidtown = (p: { lat: number; lng: number }) =>
  Math.abs(p.lat - DEMO_MIDTOWN.lat) < 0.005 && Math.abs(p.lng - DEMO_MIDTOWN.lng) < 0.005;
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
export const USER_BUTTON_APPEARANCE = { elements: { userButtonTrigger: "quest-inline hit-target" } };

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
// The map's start-up (the MapLibre module, then WebGL) holds the main thread for a good
// while, so it waits for the first answer to be on screen: the sheet, or the card in its
// place. Without one by this long, it starts anyway rather than leave the page blank.
export const MAP_WAIT_MS = 3000;

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
  // Set by a successful check-in, cleared as the stamp starts: it slams down once, and
  // never for a quest that loads already done.
  const [stampSlam, setStampSlam] = useState(false);
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
  // The sheet is open (full): on a phone it then covers the map's bottom edge.
  const [sheetOpen, setSheetOpen] = useState(false);
  const onSnapChange = useCallback((s: Snap) => setSheetOpen(s === "full"), []);
  // After "Not today", focus goes to the first reason, so the question is heard and
  // answerable where it appeared (the button pressed may be gone by then).
  const firstReasonRef = useRef<HTMLButtonElement>(null);
  const [reloads, setReloads] = useState(0);
  // The state card on screen instead of the sheet (loading, errors, surveying), if any.
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null);
  // The top bar: the notices start below it, however many lines it wraps to. The map's
  // buttons go in its second slot.
  const headerRef = useRef<HTMLElement>(null);
  const [noticesTop, setNoticesTop] = useState(64);
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
  // Where the notices end: the quest sheet's full height stops below them.
  const noticesRef = useRef<HTMLDivElement>(null);
  const [noticesBottom, setNoticesBottom] = useState(64);

  // The first /me answer, for a /quests/today request that started before it came in.
  const [meReady] = useState(() => {
    let resolve!: (m: Me) => void;
    const promise = new Promise<Me>((r) => (resolve = r));
    return { promise, resolve };
  });
  useEffect(() => {
    api<Me>("/me").then(
      (m) => {
        setDemo(!!m.demo);
        setMe(m);
        setMeError(null);
        meReady.resolve(m);
      },
      setMeError,
    );
  }, [api, meTries, meReady]);

  // Refetch on a new location, after an action, a retry or a survey poll. `stale` drops
  // a slow response for an old location that lands after a newer one.
  // Keyed on the coordinates, not the object: a new note (e.g. a location retry that
  // ends on the same demo spot) is not a new place.
  // The first request doesn't wait for /me: both start at once, and the answer is read
  // once /me is in (a failed /me's retry included). An account that isn't onboarded
  // never sees it (onboarding comes first, as before). Only the demo spot waits for /me:
  // which spot it is depends on the account (demoAccountLocation).
  const lat = loc?.lat;
  const lng = loc?.lng;
  const canAsk = me ? me.onboarded : located?.source !== "demo";
  const request = lat !== undefined && canAsk ? `${lat},${lng}#${reloads}` : null;
  const loading = request !== null && answered !== request;
  useEffect(() => {
    if (request === null) return;
    const key = request;
    let stale = false;
    const settled = api<Today>(`/quests/today?lat=${lat}&lng=${lng}`).then(
      (t) => ({ t }),
      (e: unknown) => ({ e }),
    );
    Promise.all([settled, meReady.promise]).then(([res, m]) => {
      if (stale || !m.onboarded) return;
      if ("e" in res) {
        setTodayError(res.e);
        setAnswered(key);
        return;
      }
      const t = res.t;
      // The demo account outside the demo region, with nothing loaded here: Midtown
      // instead (demoAccountLocation), and this empty answer is never shown.
      const empty = !t.quest && !t.deck.length && !(t.surveying?.pending.length ?? 0);
      if (m.demo && loc?.source === "gps" && empty && (t.surveying?.outside?.length ?? 0) > 0) {
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
    });
    return () => {
      stale = true;
    };
    // The request key covers the coordinates, the reload count and whether to ask at
    // all; loc's source only matters with new coordinates. /me landing on an onboarded
    // account doesn't change the key, so it doesn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, request, meReady]);

  // The map mounts once the first answer has painted (a frame, then a task: after the
  // paint), or after MAP_WAIT_MS. It fills in behind the sheet, which doesn't move.
  const [mapOn, setMapOn] = useState(false);
  const firstAnswer = !!(today || todayError || meError);
  const hasLoc = loc !== null;
  useEffect(() => {
    if (mapOn || !hasLoc) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    let raf: number | undefined;
    if (firstAnswer) raf = requestAnimationFrame(() => (t = setTimeout(() => setMapOn(true), 0)));
    else t = setTimeout(() => setMapOn(true), MAP_WAIT_MS);
    return () => {
      if (raf !== undefined) cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [mapOn, hasLoc, firstAnswer]);

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

  // The state cards (loading, errors, surveying) report their height here; the quest
  // sheet reports its own settled height through onCoveredChange.
  useEffect(() => {
    const el = cardEl;
    if (!el) return;
    const ro = new ResizeObserver(() => onCoveredChange({ bottom: el.offsetHeight, right: 0 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [cardEl, onCoveredChange]);

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

  useEffect(() => {
    if (setAside) firstReasonRef.current?.focus();
  }, [setAside]);

  // Each quest offered, once (refreshes and survey polls hand back the same one).
  const offered = useRef(new Set<string>());
  const offer = today?.quest?.status === "offered" ? today.quest : null;
  useEffect(() => {
    if (!offer || offered.current.has(offer.id)) return;
    offered.current.add(offer.id);
    track("quest_offered", questProps(offer.place));
  }, [offer]);

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
      if (action === "accept") track("quest_accepted", questProps(quest.place));
      if (action === "skip") track("quest_skipped", questProps(quest.place));
      if (action === "not-today") track("quest_not_today", questProps(quest.place));
      if (action === "complete") track("checkin_attempted", { result: "checked_in", simulated: !!res?.simulated });
      if (action === "not-today") setSetAside(questId);
      if (action === "complete") {
        setCheckIn(checkedIn(placeName, res));
        setFinished({ ...quest, status: "completed" });
        setStampSlam(true);
      }
      reload();
    } catch (e) {
      if (action === "complete") track("checkin_attempted", { result: checkinFailure(e), simulated: false });
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
      track("not_today_reason", { reason });
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
      {/* The pill and the map's buttons side by side, or the buttons on a second line
          (right-aligned) when both don't fit: large text, zoom, a narrow screen. */}
      <header
        ref={headerRef}
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-wrap items-start justify-between gap-2 px-3 pt-3"
      >
        {/* Wraps too, at the narrowest (200% zoom on a phone): rounded-3xl looks the same as
            rounded-full on one line and stays a card on two. */}
        <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-x-3 rounded-3xl border border-paper-edge bg-paper/90 py-1 pl-4 pr-1 shadow-sm backdrop-blur">
          <h1 className="text-lg font-semibold tracking-tight">Larper</h1>
          <Link
            href="/journal"
            className="quest-inline hit-target rounded font-mono text-xs uppercase tracking-wider text-ink-soft underline underline-offset-4"
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
          <p role="status" className="field-label motion-safe:animate-pulse rounded border border-rule bg-paper/95 px-3 py-1.5">
            Getting a precise fix…
          </p>
        )}

        {surveying && (
          <p
            role="status"
            className={`field-label rounded border border-rule bg-paper/95 px-3 py-1.5 ${surveyOverdue ? "" : "motion-safe:animate-pulse"}`}
          >
            {surveyOverdue ? "Still surveying" : "Surveying the area…"} mapping {today!.surveying!.pending.length} new{" "}
            {today!.surveying!.pending.length === 1 ? "district" : "districts"}
          </p>
        )}

        {setAside && (
          <div role="region" aria-label="Why not today?" className="w-full rounded border border-rule bg-paper/95 px-3 py-2 text-sm">
            <div className="flex items-center gap-3">
              <p id="why-not-today" className="flex-1">
                <span className="font-medium">Set aside for today.</span> Want to say why? It&apos;s optional.
              </p>
              <button onClick={() => setSetAside(null)} aria-label="No reason" className="quest-inline hit-target rounded px-1">
                ×
              </button>
            </div>
            {/* Named by the question, so focus landing on the first reason reads it out. */}
            <div role="group" aria-labelledby="why-not-today" className="mt-2 flex flex-wrap gap-2">
              {SKIP_REASONS.map(({ reason, label }, i) => (
                <button
                  key={reason}
                  ref={i === 0 ? firstReasonRef : undefined}
                  onClick={() => giveReason(reason)}
                  disabled={busy}
                  className="quest-raised min-h-11 rounded-full border border-ink-faint bg-paper px-4 disabled:opacity-50"
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
              <button onClick={banner.retry} disabled={banner.pending} className="quest-inline rounded font-medium underline disabled:opacity-50">
                {banner.pending ? "Retrying…" : banner.label}
              </button>
            )}
            <button
              onClick={() => (actionError ? setActionError(null) : setTodayError(null))}
              aria-label="Dismiss"
              className="quest-inline hit-target rounded px-1"
            >
              ×
            </button>
          </div>
        )}
      </div>

      {/* Keyed by state: a new state is a new card, so an alert is announced as one. */}
      {!loc ? (
        <StateCard key="Finding you…" ref={setCardEl} role="status" label="Finding you…" placeholder />
      ) : meError && !me ? (
        <StateCard
          key="Couldn't load your journal"
          ref={setCardEl}
          role="alert"
          label="Couldn't load your journal"
          body={describeError(meError)}
          action={{ text: "Retry", onClick: retryMe }}
        />
      ) : !today && todayError ? (
        <StateCard
          key="Couldn't load your quest"
          ref={setCardEl}
          role="alert"
          label="Couldn't load your quest"
          body={describeError(todayError)}
          action={{ text: loading ? "Retrying…" : "Retry", onClick: reload, disabled: loading }}
        />
      ) : !today ? (
        <StateCard key="Loading your quest…" ref={setCardEl} role="status" label="Loading your quest…" placeholder />
      ) : surveying && !today.deck.length && quest?.status !== "completed" ? (
        surveyOverdue ? (
          <StateCard
            key="Taking longer than usual"
            ref={setCardEl}
            role="status"
            label="Taking longer than usual"
            body="This area is still being surveyed. Check again in a bit, or try somewhere else."
            action={{ text: "Check again", onClick: keepSurveying }}
          />
        ) : (
          <StateCard
            key="Uncharted territory"
            ref={setCardEl}
            role="status"
            label="Uncharted territory"
            body="Nobody's mapped this area yet. Surveying it now; your quest appears here in a minute or so."
          />
        )
      ) : !quest && !deck.length && (today.surveying?.outside?.length ?? 0) > 0 && !surveying ? (
        // Nothing loaded here, and the API won't load it: Larper covers one city.
        me?.demo ? (
          <StateCard
            key="Outside the demo area"
            ref={setCardEl}
            role="status"
            label="Outside the demo area"
            body="This demo covers New York City. Try it from Washington Square instead."
            action={{ text: "Go to the demo area", onClick: () => window.location.assign(demoAreaUrl()) }}
          />
        ) : (
          <StateCard
            key="Outside New York City"
            ref={setCardEl}
            role="status"
            label="Outside New York City"
            body="Larper covers New York City so far. You can look around Midtown in the meantime."
            action={seeMidtown}
          />
        )
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
          stampSlam={stampSlam}
          onStampSlammed={() => setStampSlam(false)}
          onSnapChange={onSnapChange}
        />
      ) : (
        // Nothing here. Asking again gives the same answer (a failed survey is retried
        // within the hour), so the action goes where there is something: Midtown.
        <StateCard
          key="Uncharted"
          ref={setCardEl}
          role="status"
          label="Uncharted"
          body={
            today.surveying?.failed.length
              ? "Couldn't survey this area just now. Larper tries again within the hour."
              : "Nothing quest-worthy within reach here. Try somewhere livelier."
          }
          action={loc && isMidtown(loc) ? undefined : seeMidtown}
        />
      )}

      {/* After the header and the sheet, so the Tab order reaches today's quest before the
          map's pins and credit (the map draws underneath them all the same). */}
      {loc && mapOn && <QuestMap
        me={loc}
        quest={quest}
        deck={deck}
        selectedId={selected}
        onSelect={setSelectedId}
        bottomInset={covered.bottom}
        rightInset={covered.right}
        bottomCovered={sheetOpen && covered.right === 0}
        controlsHost={controlsHost}
      />}
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

// Why a check-in didn't go through, for analytics: the geofence's two refusals (a 422
// with the API's code), or anything else.
export function checkinFailure(e: unknown): CheckinResult {
  if (e instanceof ApiError && e.status === 422 && (e.code === "too_far" || e.code === "too_rough")) return e.code;
  return "failed";
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">{children}</main>;
}
