"use client";

import LarperOsQuestMap from "@/components/map/larper-os-quest-map";
import type { DeckItem } from "@/lib/api";
import { center, deck, quest } from "./quest-fixture-data";

const emptyDeck: DeckItem[] = [];

/** The live Larper OS map, with `at` pinning the time of day (the lab's scrubber and ?time=). */
export default function DayMapFixture({ showQuest, selectedId, onSelect, bottomInset, rightInset, at }: {
  showQuest: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  bottomInset: number;
  rightInset: number;
  at?: Date;
}) {
  return (
    <LarperOsQuestMap at={at} me={center} quest={showQuest ? quest : null}
      deck={showQuest ? deck : emptyDeck} selectedId={showQuest ? selectedId : null}
      onSelect={onSelect} bottomInset={bottomInset} rightInset={rightInset} />
  );
}
