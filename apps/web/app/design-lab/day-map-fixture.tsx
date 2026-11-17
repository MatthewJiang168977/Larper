"use client";

import MapLibreQuestMap from "@/components/map/maplibre-quest-map";
import { larperOsDayStyle } from "@/components/map/larper-os-style";
import type { DeckItem } from "@/lib/api";
import { center, deck, quest } from "./quest-fixture-data";

const emptyDeck: DeckItem[] = [];


export default function DayMapFixture({ showQuest, selectedId, onSelect, bottomInset, rightInset }: {
  showQuest: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  bottomInset: number;
  rightInset: number;
}) {
  return (
    <MapLibreQuestMap initialStyle={larperOsDayStyle} me={center} quest={showQuest ? quest : null}
      deck={showQuest ? deck : emptyDeck} selectedId={showQuest ? selectedId : null}
      onSelect={onSelect} bottomInset={bottomInset} rightInset={rightInset} />
  );
}
