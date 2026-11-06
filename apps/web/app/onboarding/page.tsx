"use client";

import Link from "next/link";
import { RequireSignIn } from "@/components/require-sign-in";
import { humanize } from "@/components/quest/why-lines";
import { useCallback, useEffect, useRef, useState } from "react";
import { setDemo, track } from "@/lib/analytics";
import { describeError, useApi, type Me, type VibeCard } from "@/lib/api";

const SWIPE_PX = 90;

// For calls whose 4xx text is for developers, not people ("unknown card x in liked").
const CARDS_FAILED = "Couldn't load the vibes.";
const SAVE_FAILED = "Couldn't save your answers.";

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
  const [cardsTries, setCardsTries] = useState(0);
  // Every answer so far, in order: the last one can be taken back.
  const [answers, setAnswers] = useState<{ id: string; like: boolean }[]>([]);
  const [result, setResult] = useState<Pick<Me, "topTags"> | null>(null);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<number | null>(null);

  useEffect(() => {
    api<VibeCard[]>("/onboarding/cards").then(
      setCards,
      (e: unknown) => setCardsError(describeError(e, CARDS_FAILED)),
    );
  }, [api, cardsTries]);

  const index = answers.length;
  const liked = answers.filter((a) => a.like).map((a) => a.id);
  const passed = answers.filter((a) => !a.like).map((a) => a.id);
  const done = cards.length > 0 && index >= cards.length;

  const answer = useCallback(
    (like: boolean) => {
      const card = cards[index];
      if (!card) return;
      setAnswers((xs) => [...xs, { id: card.id, like }]);
      setDragX(0);
    },
    [cards, index],
  );
  const undo = () => setAnswers((xs) => xs.slice(0, -1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") answer(true);
      if (e.key === "ArrowLeft") answer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [answer]);

  // Saved once every card has an answer. "Try again" after a failure clears the error,
  // which sends the same answers again: it never throws them away.
  const likedKey = liked.join(",");
  const passedKey = passed.join(",");
  useEffect(() => {
    if (!done || result || saveError) return;
    if (!likedKey) return; // shown as a prompt to go again below
    api<Me>("/onboarding", {
      method: "POST",
      body: JSON.stringify({ liked: likedKey.split(","), passed: passedKey ? passedKey.split(",") : [] }),
    }).then(
      (m) => {
        setDemo(!!m.demo);
        track("onboarding_finished");
        setResult(m);
      },
      (e: unknown) => setSaveError(describeError(e, SAVE_FAILED)),
    );
  }, [done, likedKey, passedKey, result, saveError, api]);

  const restart = () => {
    setAnswers([]);
    setResult(null);
    setSaveError(null);
  };

  if (cardsError) {
    return (
      <Shell>
        <Failure label="Couldn't load the vibes" text={cardsError} onRetry={() => {
            setCardsError(null);
            setCardsTries((n) => n + 1);
          }} />
      </Shell>
    );
  }

  if (cards.length === 0) {
    return (
      <Shell>
        <p role="status" className="field-label">
          Shuffling the vibes…
        </p>
      </Shell>
    );
  }

  if (done) {
    if (liked.length === 0) {
      return (
        <Shell>
          <p>You passed on everything. Pick at least one so we know where to start.</p>
          <div className="flex flex-wrap justify-center gap-3">
            <UndoButton onClick={undo} />
            <button onClick={restart} className="stamp-btn min-h-11 rounded-md bg-oxblood px-4 py-2 text-paper">
              Go again
            </button>
          </div>
        </Shell>
      );
    }
    if (saveError) {
      return (
        <Shell>
          <Failure label="Couldn't save your answers" text={saveError} onRetry={() => setSaveError(null)} />
        </Shell>
      );
    }
    return (
      <Shell>
        {result ? (
          <>
            {/* The journal's stamp, as the ending: the log is open. */}
            <div role="status">
              <h1 className="-rotate-3 rounded border-2 border-oxblood px-4 py-2 font-mono text-xl font-semibold uppercase tracking-wider text-oxblood">
                Your quest log is open
              </h1>
            </div>
            {result.topTags.length > 0 && (
              <>
                <p className="text-ink-soft">Leaning toward:</p>
                <ul className="flex flex-wrap justify-center gap-2">
                  {result.topTags.map((t) => (
                    <li key={t} className="rounded-full border border-ink-faint px-3 py-1 font-mono text-xs">
                      {humanize(t)}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <Link href="/" className="stamp-btn inline-flex min-h-11 items-center rounded-md bg-oxblood px-5 py-2 text-paper">
              See today&apos;s quest
            </Link>
          </>
        ) : (
          <p role="status" className="field-label">
            Saving…
          </p>
        )}
      </Shell>
    );
  }

  const card = cards[index];
  const tilt = dragX / 12;
  return (
    <Shell>
      <p className="max-w-sm text-ink-soft">
        Swipe right on what you&apos;re into, left on what you&apos;re not. Your answers pick where your quests send you.
      </p>
      {/* Announced as each card comes up, with the card's title. */}
      <p className="field-label" aria-live="polite" aria-atomic="true">
        Vibe {index + 1} of {cards.length}
        <span className="sr-only">: {card.title}</span>
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
      {index > 0 && <UndoButton onClick={undo} />}
    </Shell>
  );
}

// Takes back the last answer: that card comes up again.
function UndoButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="hit-target font-mono text-xs uppercase tracking-wider text-ink-soft underline underline-offset-4">
      Undo last answer
    </button>
  );
}

function Failure({ label, text, onRetry }: { label: string; text: string; onRetry: () => void }) {
  return (
    <div role="alert" className="max-w-sm rounded border border-oxblood px-4 py-3 text-oxblood">
      <p className="field-label text-oxblood">{label}</p>
      <p className="mt-0.5">{text}</p>
      <button onClick={onRetry} className="hit-target mt-1 font-medium underline">
        Try again
      </button>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 text-center">{children}</main>;
}
