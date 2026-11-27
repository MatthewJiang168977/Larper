"use client";

import type { WasOpenAnswer } from "@/lib/api";
import { OneTapQuestion } from "./one-tap-question";

const CHOICES: { answer: WasOpenAnswer; label: string }[] = [
  { answer: "yes", label: "yes" },
  { answer: "no", label: "no" },
  { answer: "didnt_check", label: "didn't check" },
];

/** The optional question under "done for today": was the place open? */
export function WasOpenQuestion(props: {
  answer: WasOpenAnswer | null;
  onAnswer: (answer: WasOpenAnswer) => Promise<void>;
}) {
  return <OneTapQuestion label="was it open?" choices={CHOICES} {...props} />;
}
