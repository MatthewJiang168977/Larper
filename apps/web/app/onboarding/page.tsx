"use client";

import { useCallback } from "react";
import { OnboardingFlow } from "@/components/larper-os/onboarding";
import { RequireSignIn } from "@/components/require-sign-in";
import { setDemo, track } from "@/lib/analytics";
import { useApi, type Me, type VibeCard } from "@/lib/api";

export default function OnboardingPage() {
  return <RequireSignIn><Onboarding /></RequireSignIn>;
}

function Onboarding() {
  const api = useApi();
  const loadCards = useCallback(() => api<VibeCard[]>("/onboarding/cards"), [api]);
  const saveAnswers = useCallback(async (answers: { liked: string[]; passed: string[] }) => {
    const result = await api<Me>("/onboarding", {
      method: "POST",
      body: JSON.stringify(answers),
    });
    setDemo(!!result.demo);
    track("onboarding_finished");
    return result;
  }, [api]);

  return <OnboardingFlow loadCards={loadCards} saveAnswers={saveAnswers} />;
}
