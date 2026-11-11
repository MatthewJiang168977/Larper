"use client";

import { useCallback, useRef, useState } from "react";
import { OnboardingFlow } from "@/components/larper-os/onboarding";
import { ApiError, type VibeCard } from "@/lib/api";

const scenarios = ["normal", "load error", "save error"] as const;
type Scenario = typeof scenarios[number];

const cards: VibeCard[] = [
  { id: "tea", title: "Matcha, hojicha, anything green", blurb: "A tea bar where they whisk it in front of you." },
  { id: "nightlife", title: "The bar with no sign", blurb: "Down the stairs, through the phone booth." },
  { id: "comics", title: "Comics in a back room", blurb: "A shop with a shelf of small press comics." },
];
const tags: Record<string, string> = { tea: "matcha", nightlife: "speakeasy", comics: "comics" };

function Fixture({ scenario, controls }: { scenario: Scenario; controls: React.ReactNode }) {
  const attemptedSave = useRef(false);
  const loadCards = useCallback(async (attempt: number) => {
    if (scenario === "load error" && attempt === 0) throw new ApiError("preview load error", 0, "network");
    return cards;
  }, [scenario]);
  const saveAnswers = useCallback(async ({ liked }: { liked: string[] }) => {
    if (scenario === "save error" && !attemptedSave.current) {
      attemptedSave.current = true;
      throw new ApiError("preview save error", 0, "network");
    }
    return { topTags: liked.map((id) => tags[id]) };
  }, [scenario]);

  return <OnboardingFlow loadCards={loadCards} saveAnswers={saveAnswers} questHref="/design-lab" previewControls={controls} />;
}

export function OnboardingFixture() {
  const [scenario, setScenario] = useState<Scenario>("normal");

  return (
    <Fixture key={scenario} scenario={scenario} controls={
      <label className="larper-onboarding-preview">
        fixture scenario
        <select value={scenario} onChange={(event) => setScenario(event.target.value as Scenario)}>
          {scenarios.map((item) => <option key={item}>{item}</option>)}
        </select>
      </label>
    } />
  );
}
