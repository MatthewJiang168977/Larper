"use client";

import { useCallback, useRef, useState } from "react";
import { QuestScreen } from "@/components/quest/quest-home";
import { ApiError, type Today, type useApi } from "@/lib/api";
import type { LocationState } from "@/hooks/use-location";
import { center, deck, quest } from "../quest-fixture-data";

const scenarios = ["offered", "accepted", "completed", "loading", "error", "empty", "surveying", "rejected"] as const;
type Scenario = typeof scenarios[number];
const location: LocationState = {
  loc: { ...center, source: "override" },
  retry: () => {},
  retrying: false,
};
const leadDetails = [
  { category: "record_shop", distanceM: 280 },
  { category: "tea_room", distanceM: 170 },
  { category: "bar", distanceM: 360 },
];
const sampleDeck = deck.map((item, index) => ({
  ...item, place: { ...item.place, ...leadDetails[index] },
}));

function Fixture({ scenario, controls }: { scenario: Scenario; controls: React.ReactNode }) {
  const current = useRef({
    ...quest,
    status: scenario === "completed" ? "completed" as const : scenario === "accepted" || scenario === "rejected" ? "accepted" as const : "offered" as const,
    place: { ...quest.place, category: "record_shop", tags: ["vinyl"], distanceM: 395 },
    reasons: { liked: ["vinyl"], rarest: null, indie: true },
  });
  const failed = useRef(false);
  const api: ReturnType<typeof useApi> = useCallback(async <T,>(path: string) => {
    if (path === "/me") return { id: "fixture", onboarded: true, topTags: ["vinyl"] } as T;
    if (path.startsWith("/quests/today")) {
      if (scenario === "loading") return new Promise<T>(() => {});
      if (scenario === "error" && !failed.current) {
        failed.current = true;
        throw new ApiError("fixture unavailable", 503);
      }
      const hasQuest = scenario !== "empty" && scenario !== "surveying";
      const today: Today = {
        quest: hasQuest ? current.current : null,
        deck: hasQuest && current.current.status !== "completed"
          ? sampleDeck.filter(({ place }) => place.id !== current.current.place.id)
          : [],
        cache: "hit",
        surveying: scenario === "surveying" ? { pending: ["sample"], failed: [] } : null,
      };
      return today as T;
    }
    if (path.endsWith("/accept")) current.current = { ...current.current, status: "accepted" };
    if (path.endsWith("/complete")) {
      if (scenario === "rejected") throw new ApiError("you’re too far away. check in when you’re there.", 422, "http", "too_far");
      current.current = { ...current.current, status: "completed" };
    }
    if (path.endsWith("/skip") || path.endsWith("/not-today")) {
      current.current = { ...current.current, id: "next-sample", status: "offered", place: sampleDeck[0].place };
    }
    return null as T;
  }, [scenario]);

  return <QuestScreen api={api} location={location} previewControls={controls} />;
}

export function QuestScreenFixture() {
  const [scenario, setScenario] = useState<Scenario>("offered");
  return <Fixture key={scenario} scenario={scenario} controls={
    <label className="larper-quest-preview">
      sample quest
      <select value={scenario} onChange={(event) => setScenario(event.target.value as Scenario)}>
        {scenarios.map((item) => <option key={item}>{item}</option>)}
      </select>
    </label>
  } />;
}
