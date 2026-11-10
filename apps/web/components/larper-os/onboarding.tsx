"use client";

import Link from "next/link";
import { larperOsClassName } from "@/app/larper-os";
import { humanize } from "@/components/quest/why-lines";
import { useCallback, useEffect, useRef, useState } from "react";
import { describeError, type Me, type VibeCard } from "@/lib/api";
import { OSButton, OSMenuBar, OSQuestPanel, OSWindow, osPrimaryButtonClass } from "./primitives";
import "./onboarding.css";

const SWIPE_PX = 90;

// For calls whose 4xx text is for developers, not people ("unknown card x in liked").
const CARDS_FAILED = "Couldn't load the vibes.";
const SAVE_FAILED = "Couldn't save your answers.";

export function OnboardingFlow({ loadCards, saveAnswers, questHref = "/", previewControls }: {
  loadCards: (attempt: number) => Promise<VibeCard[]>;
  saveAnswers: (answers: { liked: string[]; passed: string[] }) => Promise<Pick<Me, "topTags">>;
  questHref?: string;
  previewControls?: React.ReactNode;
}) {
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
    let active = true;
    loadCards(cardsTries).then(
      (loaded) => { if (active) setCards(loaded); },
      (e: unknown) => { if (active) setCardsError(describeError(e, CARDS_FAILED)); },
    );
    return () => { active = false; };
  }, [loadCards, cardsTries]);

  const index = answers.length;
  const liked = answers.filter((a) => a.like).map((a) => a.id);
  const passed = answers.filter((a) => !a.like).map((a) => a.id);
  const done = cards.length > 0 && index >= cards.length;

  const answer = useCallback(
    (like: boolean) => {
      const card = cards[index];
      if (!card) return;
      setAnswers((xs) => xs.length === index ? [...xs, { id: card.id, like }] : xs);
      setDragX(0);
    },
    [cards, index],
  );
  const undo = () => setAnswers((xs) => xs.slice(0, -1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey ||
          (e.target instanceof HTMLElement && e.target.closest("input, select, textarea, [contenteditable]"))) return;
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
    saveAnswers({ liked: likedKey.split(","), passed: passedKey ? passedKey.split(",") : [] }).then(
      setResult,
      (e: unknown) => setSaveError(describeError(e, SAVE_FAILED)),
    );
  }, [done, likedKey, passedKey, result, saveError, saveAnswers]);

  const restart = () => {
    setAnswers([]);
    setResult(null);
    setSaveError(null);
  };

  if (cardsError) {
    return (
      <Shell previewControls={previewControls}>
        <Failure label="Couldn't load the vibes" text={cardsError} onRetry={() => {
            setCardsError(null);
            setCardsTries((n) => n + 1);
          }} />
      </Shell>
    );
  }

  if (cards.length === 0) {
    return (
      <Shell previewControls={previewControls}>
        <p role="status" className="larper-onboarding-label">
          Shuffling the vibes…
        </p>
      </Shell>
    );
  }

  if (done) {
    if (liked.length === 0) {
      return (
        <Shell previewControls={previewControls}>
          <p>You passed on everything. Pick at least one so we know where to start.</p>
          <div className="larper-onboarding-actions">
            <UndoButton onClick={undo} />
            <OSButton primary onClick={restart}>Go again</OSButton>
          </div>
        </Shell>
      );
    }
    if (saveError) {
      return (
        <Shell previewControls={previewControls}>
          <Failure label="Couldn't save your answers" text={saveError} onRetry={() => setSaveError(null)} />
        </Shell>
      );
    }
    return (
      <Shell previewControls={previewControls} complete={!!result}>
        {result ? (
          <>
            {/* The journal's stamp, as the ending: the log is open. */}
            <OSQuestPanel role="status">
              <h1 className="larper-onboarding-complete">
                Your quest log is open
              </h1>
            </OSQuestPanel>
            {result.topTags.length > 0 && (
              <>
                <p>Leaning toward:</p>
                <ul className="larper-onboarding-tags">
                  {result.topTags.map((t) => (
                    <li key={t}>
                      {humanize(t)}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <Link href={questHref} className={osPrimaryButtonClass}>
              See today&apos;s quest
            </Link>
          </>
        ) : (
          <p role="status" className="larper-onboarding-label">
            Saving…
          </p>
        )}
      </Shell>
    );
  }

  const card = cards[index];
  const tilt = dragX / 12;
  return (
    <Shell previewControls={previewControls}>
      <p>
        Swipe right on what you&apos;re into, left on what you&apos;re not. Your answers pick where your quests send you.
      </p>
      {/* Announced as each card comes up, with the card's title. */}
      <p className="larper-onboarding-label" role="status" aria-live="polite" aria-atomic="true">
        Vibe <span className="num">{index + 1}</span> of <span className="num">{cards.length}</span>
        <span className="sr-only">: {card.title}</span>
      </p>
      <div
        className="larper-onboarding-card"
        data-dragging={dragging}
        style={{ transform: `translateX(${dragX}px) rotate(${tilt}deg)` }}
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
        onPointerCancel={() => {
          dragStart.current = null;
          setDragging(false);
          setDragX(0);
        }}
      >
        <h2>{card.title}</h2>
        <p>{card.blurb}</p>
      </div>
      <div className="larper-onboarding-actions">
        <OSButton onClick={() => answer(false)}>← Not really</OSButton>
        <OSButton primary onClick={() => answer(true)}>Into it →</OSButton>
      </div>
      {index > 0 && <UndoButton onClick={undo} />}
    </Shell>
  );
}

// Takes back the last answer: that card comes up again.
function UndoButton({ onClick }: { onClick: () => void }) {
  return <OSButton onClick={onClick}>Undo last answer</OSButton>;
}

function Failure({ label, text, onRetry }: { label: string; text: string; onRetry: () => void }) {
  return (
    <>
      <OSQuestPanel role="alert">
        <h2 className="larper-onboarding-label">{label}</h2>
        <p>{text}</p>
      </OSQuestPanel>
      <OSButton primary onClick={onRetry}>Try again</OSButton>
    </>
  );
}

function Shell({ children, complete, previewControls }: {
  children: React.ReactNode;
  complete?: boolean;
  previewControls?: React.ReactNode;
}) {
  return (
    <main className={`${larperOsClassName} larper-onboarding`}>
      {previewControls && <OSMenuBar>{previewControls}</OSMenuBar>}
      <div className="larper-onboarding-stage">
        <OSWindow title={complete ? "all_set.txt" : "vibe_check.exe"}>
          {!complete && <h1 className="larper-onboarding-heading">Set your vibes</h1>}
          {children}
        </OSWindow>
      </div>
    </main>
  );
}
