"use client";

import { useEffect, useId, useRef, useState } from "react";
import { OSButton } from "@/components/larper-os/primitives";
import type { WasOpenAnswer } from "@/lib/api";

const CHOICES: { answer: WasOpenAnswer; label: string }[] = [
  { answer: "yes", label: "yes" },
  { answer: "no", label: "no" },
  { answer: "didnt_check", label: "didn't check" },
];

/**
 * The optional question under "done for today": was the place open? One tap answers it
 * (or ignore it: nothing waits on it). The answer is thanked at once and sent behind
 * that; if it fails the question comes back with the reason and a way to try again.
 *
 * `answer` is what's known to be saved; `onAnswer` sends one and rejects on failure.
 */
export function WasOpenQuestion({
  answer,
  onAnswer,
}: {
  answer: WasOpenAnswer | null;
  onAnswer: (answer: WasOpenAnswer) => Promise<void>;
}) {
  const labelId = useId();
  const [pending, setPending] = useState<WasOpenAnswer | null>(null);
  const [failed, setFailed] = useState<WasOpenAnswer | null>(null);
  const thanksRef = useRef<HTMLParagraphElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  // Whether focus was in the question when it went: only then does it follow the thanks
  // (or the retry). Otherwise the question appears and goes without touching focus.
  const hadFocus = useRef(false);
  const [saved, setSaved] = useState(false);
  const thanks = answer !== null || pending !== null || saved;

  useEffect(() => {
    if (!hadFocus.current) return;
    if (thanks) thanksRef.current?.focus();
    else if (failed) groupRef.current?.querySelector<HTMLElement>(`[data-answer="${failed}"]`)?.focus();
    hadFocus.current = false;
  }, [thanks, failed]);

  const choose = (choice: WasOpenAnswer) => {
    if (pending) return;
    hadFocus.current = !!groupRef.current?.contains(document.activeElement);
    setFailed(null);
    setPending(choice);
    onAnswer(choice).then(
      () => setSaved(true),
      () => {
        // The thanks had focus (it went there): the retry takes it back.
        hadFocus.current = document.activeElement === thanksRef.current;
        setPending(null);
        setFailed(choice);
      },
    );
  };

  if (thanks) {
    return (
      <p ref={thanksRef} role="status" tabIndex={-1} className="mt-3 text-sm text-ink-soft">
        thanks, noted
      </p>
    );
  }
  return (
    <div ref={groupRef} role="group" aria-labelledby={labelId} className="mt-3">
      <p id={labelId} className="text-sm text-ink-soft">was it open?</p>
      <div className="mt-1 flex flex-wrap gap-2">
        {CHOICES.map(({ answer: choice, label }) => (
          <OSButton key={choice} data-answer={choice} onClick={() => choose(choice)}>
            {label}
          </OSButton>
        ))}
      </div>
      {failed && (
        <p role="alert" className="mt-2 text-sm text-oxblood">
          couldn&apos;t save that, try again
        </p>
      )}
    </div>
  );
}
