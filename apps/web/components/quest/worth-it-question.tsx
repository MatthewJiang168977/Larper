"use client";

import type { WorthItAnswer } from "@/lib/api";
import { OneTapQuestion } from "./one-tap-question";

const CHOICES: { answer: WorthItAnswer; label: string }[] = [
  { answer: "yes", label: "yes" },
  { answer: "meh", label: "meh" },
  { answer: "no", label: "no" },
];

/** Under "was it open?": worth the walk? Optional, and skippable. */
export function WorthItQuestion(props: {
  answer: WorthItAnswer | null;
  onAnswer: (answer: WorthItAnswer) => Promise<void>;
  onSkip: () => void;
}) {
  return <OneTapQuestion label="worth it?" choices={CHOICES} {...props} />;
}
