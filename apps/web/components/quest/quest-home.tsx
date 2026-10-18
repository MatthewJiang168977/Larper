"use client";

import { UserButton } from "@clerk/nextjs";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "@/hooks/use-location";
import { describeError, useApi, type Me, type Today } from "@/lib/api";
import { QuestSheet, type QuestAction } from "./quest-sheet";

export const SURVEY_POLL_MS = 4000;
// An area's ingest takes about a minute (longer on a one-core VM). Past this, stop
// polling and say so: the ingest-worker may be down, and the API keeps reporting the
// area as pending while its job waits or retries.
export const SURVEY_MAX_MS = 3 * 60_000;

// WebGL map: client only, and loaded after the shell so first paint isn't blocked on it.
const QuestMap = dynamic(() => import("@/components/map/maplibre-quest-map"), { ssr: false });

export function QuestHome() {
  const api = useApi();
  const loc = useLocation();
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<unknown>(null);
  const [meTries, setMeTries] = useState(0);
  const [today, setToday] = useState<Today | null>(null);
  const [todayError, setTodayError] = useState<unknown>(null);
  // Which request the latest answer (or failure) belongs to: anything else is in flight.
  const [answered, setAnswered] = useState<string | null>(null);
  const [surveyStart, setSurveyStart] = useState<number | null>(null);
  const [surveyOverdue, setSurveyOverdue] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sheetH, setSheetH] = useState(280);
  const [reloads, setReloads] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);

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
  const request = loc && me?.onboarded ? `${loc.lat},${loc.lng}#${reloads}` : null;
  const loading = request !== null && answered !== request;
  useEffect(() => {
    if (!loc || !me?.onboarded) return;
    const key = `${loc.lat},${loc.lng}#${reloads}`;
    let stale = false;
    api<Today>(`/quests/today?lat=${loc.lat}&lng=${loc.lng}`).then(
      (t) => {
        if (stale) return;
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
  }, [api, loc, me?.onboarded, reloads]);

  // While areas are being surveyed, check back until the ingest-worker finishes. Every
  // finished request, failed or not, schedules the next check, up to SURVEY_MAX_MS.
  const surveying = (today?.surveying?.pending.length ?? 0) > 0;
  useEffect(() => {
    if (!surveying || surveyOverdue || loading) return;
    const t = setTimeout(() => {
      if (surveyStart !== null && Date.now() - surveyStart > SURVEY_MAX_MS) setSurveyOverdue(true);
      else setReloads((n) => n + 1);
    }, SURVEY_POLL_MS);
    return () => clearTimeout(t);
  }, [surveying, surveyOverdue, loading, surveyStart, answered]);

  // Keep fly-to centering above the sheet as its height changes.
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSheetH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [today]);

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
    setBusy(true);
    setActionError(null);
    try {
      // Checking in sends where you are; the API only accepts it near the place.
      const body = action === "complete" && loc ? { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracyM } : undefined;
      await api(`/quests/${today.quest.id}/${action}`, { method: "POST", body: body && JSON.stringify(body) });
      reload();
    } catch (e) {
      setActionError(describeError(e));
    } finally {
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

  // A failed refresh while a deck is already on screen: keep the deck, say so above it.
  const banner = actionError
    ? { text: actionError, retry: null }
    : today && todayError
      ? { text: describeError(todayError), retry: reload }
      : null;

  return (
    <main className="relative h-dvh w-full overflow-hidden">
      {loc && <QuestMap
        me={loc}
        quest={today?.quest ?? null}
        deck={today?.deck ?? []}
        selectedId={selectedId}
        onSelect={setSelectedId}
        bottomInset={sheetH}
      />}

      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start gap-2 p-3">
        <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-paper-edge bg-paper/90 py-1 pl-4 pr-1 shadow-sm backdrop-blur">
          <span className="text-lg font-semibold tracking-tight">Larper</span>
          <Link href="/journal" className="font-mono text-xs uppercase tracking-wider text-ink-soft underline-offset-4 hover:underline">
            Journal
          </Link>
          <UserButton />
        </div>
      </header>

      {loc?.note && (
        <p className="field-label absolute left-3 top-16 z-10 rounded bg-paper/90 px-2 py-1">{loc.note}</p>
      )}

      {surveying && (
        <p
          role="status"
          className={`field-label absolute left-1/2 top-16 z-10 -translate-x-1/2 rounded border border-rule bg-paper/95 px-3 py-1.5 ${surveyOverdue ? "" : "animate-pulse"}`}
        >
          {surveyOverdue ? "Still surveying" : "Surveying the area…"} mapping {today!.surveying!.pending.length} new{" "}
          {today!.surveying!.pending.length === 1 ? "district" : "districts"}
        </p>
      )}

      {banner && (
        <div
          role="alert"
          className="absolute inset-x-3 top-24 z-20 flex items-center gap-3 rounded border border-oxblood bg-paper px-3 py-2 text-sm text-oxblood"
        >
          <p className="flex-1">{banner.text}</p>
          {banner.retry && (
            <button onClick={banner.retry} disabled={loading} className="font-medium underline disabled:opacity-50">
              {loading ? "Retrying…" : "Retry"}
            </button>
          )}
          <button
            onClick={() => (actionError ? setActionError(null) : setTodayError(null))}
            aria-label="Dismiss"
            className="px-1"
          >
            ×
          </button>
        </div>
      )}

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
      ) : surveying && !today.deck.length ? (
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
      ) : today.quest || today.deck.length ? (
        <QuestSheet
          ref={sheetRef}
          quest={today.quest}
          deck={today.deck}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAction={act}
          busy={busy}
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
