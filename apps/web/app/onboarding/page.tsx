"use client";

import Link from "next/link";
import { RequireSignIn } from "@/components/require-sign-in";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApi, type Me, type VibeCard } from "@/lib/api";

const SWIPE_PX = 90;

// One pass through the vibe cards: swipe right (or →) for "into it", left (or ←)
// for "not really". The answers seed the taste vector the quest ranking uses.
export default function OnboardingPage() {
  return (
    <RequireSignIn>
      <Onboarding />
    </RequireSignIn>
  );
}

function Onboarding() {
  const api = useApi();
  const [cards, setCards] = useState<VibeCard[]>([]);
  const [index, setIndex] = useState(0);
  const [liked, setLiked] = useState<string[]>([]);
  const [passed, setPassed] = useState<string[]>([]);
  const [result, setResult] = useState<Pick<Me, "topTags"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<number | null>(null);

  useEffect(() => {
    api<VibeCard[]>("/onboarding/cards").then(setCards, (e: Error) => setError(e.message));
  }, [api]);

  const done = cards.length > 0 && index >= cards.length;

  const answer = useCallback(
    (like: boolean) => {
      const card = cards[index];
      if (!card) return;
      (like ? setLiked : setPassed)((xs) => [...xs, card.id]);
      setIndex((i) => i + 1);
      setDragX(0);
    },
    [cards, index],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") answer(true);
      if (e.key === "ArrowLeft") answer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [answer]);

  useEffect(() => {
    if (!done || result || error) return;
    if (liked.length === 0) return; // shown as a prompt to start over below
    api<Me>("/onboarding", { method: "POST", body: JSON.stringify({ liked, passed }) }).then(
      setResult,
      (e: Error) => setError(e.message),
    );
  }, [done, liked, passed, result, error, api]);

  const restart = () => {
    setIndex(0);
    setLiked([]);
    setPassed([]);
    setResult(null);
    setError(null);
  };

  if (error) {
    return (
      <Shell>
        <p className="text-oxblood">Something broke: {error}</p>
        <button onClick={restart} className="underline">Try again</button>
      </Shell>
    );
  }

  if (cards.length === 0) return <Shell><p className="text-ink-soft">Loading…</p></Shell>;

  if (done) {
    if (liked.length === 0) {
      return (
        <Shell>
          <p>You passed on everything. Pick at least one so we know where to start.</p>
          <button onClick={restart} className="stamp-btn rounded-md bg-oxblood px-4 py-2 text-paper">Go again</button>
        </Shell>
      );
    }
    return (
      <Shell>
        {result ? (
          <>
            <h2 className="text-2xl font-semibold">Your quest log is open.</h2>
            <p className="text-ink-soft">Leaning toward:</p>
            <ul className="flex flex-wrap justify-center gap-2">
              {result.topTags.map((t) => (
                <li key={t} className="rounded-full border border-ink-faint px-3 py-1 font-mono text-xs">{t}</li>
              ))}
            </ul>
            <Link href="/" className="underline">Back home</Link>
          </>
        ) : (
          <p className="text-ink-soft">Saving…</p>
        )}
      </Shell>
    );
  }

  const card = cards[index];
  const tilt = dragX / 12;
  return (
    <Shell>
      <p className="field-label">
        Vibe {index + 1} of {cards.length}
      </p>
      <div
        className="w-full max-w-sm cursor-grab touch-none select-none rounded-xl border border-paper-edge bg-paper-deep p-8 shadow-[3px_4px_0_var(--ink)] active:cursor-grabbing"
        style={{
          transform: `translateX(${dragX}px) rotate(${tilt}deg)`,
          transition: dragging ? "none" : "transform 150ms",
        }}
        onPointerDown={(e) => {
          dragStart.current = e.clientX;
          setDragging(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (dragStart.current !== null) setDragX(e.clientX - dragStart.current);
        }}
        onPointerUp={() => {
          dragStart.current = null;
          setDragging(false);
          if (Math.abs(dragX) > SWIPE_PX) answer(dragX > 0);
          else setDragX(0);
        }}
      >
        <h2 className="text-2xl font-semibold leading-snug">{card.title}</h2>
        <p className="mt-2 text-ink-soft">{card.blurb}</p>
      </div>
      <div className="flex gap-3">
        <button onClick={() => answer(false)} className="stamp-btn rounded-md bg-paper px-4 py-2">
          ← Not really
        </button>
        <button onClick={() => answer(true)} className="stamp-btn rounded-md bg-oxblood px-4 py-2 text-paper">
          Into it →
        </button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 text-center">{children}</main>;
}
