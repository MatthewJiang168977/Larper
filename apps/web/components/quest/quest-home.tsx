"use client";

import { UserButton } from "@clerk/nextjs";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "@/hooks/use-location";
import { useApi, type Me, type Today } from "@/lib/api";
import { QuestSheet, type QuestAction } from "./quest-sheet";

// WebGL map: client only, and loaded after the shell so first paint isn't blocked on it.
const QuestMap = dynamic(() => import("@/components/map/maplibre-quest-map"), { ssr: false });

export function QuestHome() {
  const api = useApi();
  const loc = useLocation();
  const [me, setMe] = useState<Me | null>(null);
  const [today, setToday] = useState<Today | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetH, setSheetH] = useState(280);
  const [reloads, setReloads] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<Me>("/me").then(setMe, (e: Error) => setError(e.message));
  }, [api]);

  // Refetch on a new location or after an action. `stale` drops a slow response for
  // an old location that lands after a newer one.
  useEffect(() => {
    if (!loc || !me?.onboarded) return;
    let stale = false;
    api<Today>(`/quests/today?lat=${loc.lat}&lng=${loc.lng}`).then(
      (t) => {
        if (stale) return;
        setToday(t);
        setSelectedId(t.quest?.place.id ?? t.deck[0]?.place.id ?? null);
        setError(null);
      },
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [api, loc, me?.onboarded, reloads]);

  // Keep fly-to centering above the sheet as its height changes.
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSheetH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [today]);

  const act = async (action: QuestAction) => {
    if (!today?.quest) return;
    setBusy(true);
    try {
      // Checking in sends where you are; the API only accepts it near the place.
      const body = action === "complete" && loc ? { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracyM } : undefined;
      await api(`/quests/${today.quest.id}/${action}`, { method: "POST", body: body && JSON.stringify(body) });
      setReloads((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
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

      {error && (
        <p role="alert" className="absolute inset-x-3 top-24 z-20 rounded border border-oxblood bg-paper px-3 py-2 text-sm text-oxblood">
          {error}
        </p>
      )}

      {!today ? (
        <p className="field-label absolute inset-x-0 bottom-8 z-10 text-center">
          {loc ? "Surveying the area…" : "Finding you…"}
        </p>
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
        <div ref={sheetRef} className="absolute inset-x-0 bottom-0 z-10 mx-auto max-w-xl rounded-t-2xl bg-paper p-5 text-center">
          <p className="field-label">Uncharted</p>
          <p className="mt-1 text-ink-soft">
            Nothing mapped around here yet. Larper only knows New York City so far.
          </p>
        </div>
      )}
    </main>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">{children}</main>;
}
