"use client";

import { useCallback, useRef, useState } from "react";
import { QuestScreen } from "@/components/quest/quest-home";
import { ApiError, type PlaceView, type Today, type useApi, type WasOpenAnswer } from "@/lib/api";
import type { LocationState } from "@/hooks/use-location";
import { center, deck, quest } from "../quest-fixture-data";

const scenarios = [
  "offered", "accepted", "completed", "answered", "loading", "error", "empty", "surveying", "rejected",
  "hours unverified, website and phone", "hours unverified, nothing", "hours open", "hours closed, split shift", "hours unknown",
] as const;
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
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
// What each hours scenario adds to the place (open the sheet to see it).
const hoursFor: Partial<Record<Scenario, Partial<PlaceView>>> = {
  "hours unverified, website and phone": { website: "https://example.com", phone: "(212) 555-0142", hours: { status: "unverified" } },
  "hours unverified, nothing": { hours: { status: "unverified" } },
  "hours open": {
    hours: {
      status: "known", state: "open", today: [{ from: "11:00", to: "22:00", nextDay: false }],
      nextChange: { at: "22:00", day: "today", weekday: "sat", to: "closed" }, source: "osm", sourceUrl: "https://www.openstreetmap.org/node/1",
      fetchedAt: daysAgo(3), services: [],
    },
    openConfirmations: { count: 4, last: "this_week" },
  },
  "hours closed, split shift": {
    hours: {
      status: "known", state: "closed",
      today: [{ from: "11:30", to: "14:30", nextDay: false }, { from: "17:00", to: "02:00", nextDay: true }],
      nextChange: { at: "17:00", day: "today", weekday: "sat", to: "open" }, source: "website", sourceUrl: "https://example.com/hours",
      fetchedAt: daysAgo(200),
      services: [{ kind: "kitchen", state: "closed", today: [{ from: "17:00", to: "23:00", nextDay: false }] }],
    },
  },
  "hours unknown": {
    hours: {
      status: "known", state: "unknown", today: [], nextChange: null, source: "nyc_open_data", sourceUrl: null,
      fetchedAt: daysAgo(40), services: [],
    },
  },
};
const sampleDeck = deck.map((item, index) => ({
  ...item, place: { ...item.place, ...leadDetails[index] },
}));

function Fixture({ scenario, controls }: { scenario: Scenario; controls: React.ReactNode }) {
  const current = useRef({
    ...quest,
    status: scenario === "completed" || scenario === "answered" ? "completed" as const : scenario === "accepted" || scenario === "rejected" ? "accepted" as const : "offered" as const,
    place: { ...quest.place, category: "record_shop", tags: ["vinyl"], distanceM: 395, ...hoursFor[scenario] },
    wasOpen: scenario === "answered" ? ("yes" as WasOpenAnswer) : null,
    reasons: { liked: ["vinyl"], rarest: null, indie: true },
  });
  const failed = useRef(false);
  const api: ReturnType<typeof useApi> = useCallback(async <T,>(path: string, init?: RequestInit) => {
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
    if (path.endsWith("/was-open")) {
      const { answer } = JSON.parse(String(init?.body)) as { answer: WasOpenAnswer };
      current.current = { ...current.current, wasOpen: answer };
      return { wasOpen: answer } as T;
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
