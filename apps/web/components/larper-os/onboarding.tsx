"use client";

import Link from "next/link";
import { larperOsClassName } from "@/app/larper-os";
import { humanize } from "@/components/quest/why-lines";
import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { describeError, type Me, type VibeCard } from "@/lib/api";
import { OSButton, OSMenuBar, OSQuestPanel, OSWindow, osPrimaryButtonClass } from "./primitives";
import "./onboarding.css";

const SWIPE_PX = 90;

// For calls whose 4xx text is for developers, not people ("unknown card x in liked").
const CARDS_FAILED = "couldn't load the vibes.";
const SAVE_FAILED = "couldn't save your answers.";

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
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusRequested = useRef(false);

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
      if (index === cards.length - 1) focusRequested.current = true;
      setAnswers((xs) => xs.length === index ? [...xs, { id: card.id, like }] : xs);
      setDragX(0);
    },
    [cards, index],
  );
  const undo = () => {
    focusRequested.current = true;
    setAnswers((xs) => xs.slice(0, -1));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey ||
          (e.target instanceof HTMLElement && e.target.closest("input, select, textarea, [contenteditable]"))) return;
      if (e.key === "ArrowRight") answer(true);
      if (e.key === "ArrowLeft") answer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [answer]);

  // Saved once every card has an answer. "try again" after a failure clears the error,
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

  const loading = cards.length === 0 && !cardsError;
  const saving = done && !!likedKey && !result && !saveError;
  useEffect(() => {
    if (!focusRequested.current) return;
    headingRef.current?.focus();
    focusRequested.current = loading || saving;
  }, [index, loading, saving, cardsError, saveError, result]);

  const restart = () => {
    setAnswers([]);
    setResult(null);
    setSaveError(null);
  };

  if (cardsError) {
    return (
      <Shell previewControls={previewControls}>
        <Failure headingRef={headingRef} label="couldn't load the vibes" text={cardsError} onRetry={() => {
            focusRequested.current = true;
            setCardsError(null);
            setCardsTries((n) => n + 1);
          }} />
      </Shell>
    );
  }

  if (cards.length === 0) {
    return (
      <Shell previewControls={previewControls} headingRef={headingRef}>
        <p role="status" className="larper-onboarding-label">
          shuffling the vibes…
        </p>
      </Shell>
    );
  }

  if (done) {
    if (liked.length === 0) {
      return (
        <Shell previewControls={previewControls}>
          <h2 ref={headingRef} tabIndex={-1}>you passed on everything. pick at least one so we know where to start.</h2>
          <div className="larper-onboarding-actions">
            <UndoButton onClick={undo} />
            <OSButton primary onClick={restart}>go again</OSButton>
          </div>
        </Shell>
      );
    }
    if (saveError) {
      return (
        <Shell previewControls={previewControls}>
          <Failure headingRef={headingRef} label="couldn't save your answers" text={saveError} onRetry={() => {
            focusRequested.current = true;
            setSaveError(null);
          }} />
        </Shell>
      );
    }
    return (
      <Shell previewControls={previewControls} complete={!!result} headingRef={headingRef}>
        {result ? (
          <>
            {/* The journal's stamp, as the ending: the log is open. */}
            <OSQuestPanel role="status">
              <h1 ref={headingRef} tabIndex={-1} className="larper-onboarding-complete">
                your quest log is open
              </h1>
            </OSQuestPanel>
            {result.topTags.length > 0 && (
              <>
                <p>leaning toward:</p>
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
              see today&apos;s quest
            </Link>
          </>
        ) : (
          <p role="status" className="larper-onboarding-label">
            saving…
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
        swipe right on what you&apos;re into, left on what you&apos;re not. your answers pick where your quests send you.
      </p>
      {/* Announced as each card comes up, with the card's title. */}
      <p className="larper-onboarding-label" role="status" aria-live="polite" aria-atomic="true">
        vibe <span className="num">{index + 1}</span> of <span className="num">{cards.length}</span>
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
        <h2 ref={headingRef} tabIndex={-1}>{card.title}</h2>
        <p>{card.blurb}</p>
      </div>
      <div className="larper-onboarding-actions">
        <OSButton onClick={() => answer(false)}>← not really</OSButton>
        <OSButton primary onClick={() => answer(true)}>into it →</OSButton>
      </div>
      {index > 0 && <UndoButton onClick={undo} />}
    </Shell>
  );
}

// Takes back the last answer: that card comes up again.
function UndoButton({ onClick }: { onClick: () => void }) {
  return <OSButton onClick={onClick}>undo last answer</OSButton>;
}

function Failure({ label, text, onRetry, headingRef }: {
  label: string;
  text: string;
  onRetry: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  return (
    <>
      <OSQuestPanel role="alert">
        <h2 ref={headingRef} tabIndex={-1} className="larper-onboarding-label">{label}</h2>
        <p>{text}</p>
      </OSQuestPanel>
      <OSButton primary onClick={onRetry}>try again</OSButton>
    </>
  );
}

function Shell({ children, complete, previewControls, headingRef }: {
  children: React.ReactNode;
  complete?: boolean;
  previewControls?: React.ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <main className={`${larperOsClassName} larper-onboarding`}>
      {previewControls && <OSMenuBar>{previewControls}</OSMenuBar>}
      <div className="larper-onboarding-stage">
        <OSWindow title={complete ? "all_set.txt" : "vibe_check.exe"}>
          {!complete && <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="larper-onboarding-heading">set your vibes</h1>}
          {children}
        </OSWindow>
      </div>
    </main>
  );
}
