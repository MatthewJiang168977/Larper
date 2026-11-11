"use client";

import MapLibreQuestMap from "@/components/map/maplibre-quest-map";
import { makeQuestMapStyle } from "@/components/map/journal-style";
import type { DeckItem } from "@/lib/api";
import { center, deck, quest } from "./quest-fixture-data";

const emptyDeck: DeckItem[] = [];
const dayStyle = makeQuestMapStyle({
  paper: "#f6d5d5",
  paperDeep: "#f4cbd5",
  park: "#cde6be",
  wood: "#cde6be",
  water: "#a9dde3",
  waterLine: "#74bcc6",
  waterLabel: "#3a2432",
  inkMajor: "#fff9f2",
  inkMinor: "#fff9f2",
  inkPath: "#fff9f2",
  building: "#fff6ec",
  buildingTop: "#f6e6d6",
  buildingEdge: "#f0d9ca",
  label: "#3a2432",
  labelHalo: "#f6d5d5",
}, {
  anchor: "map", color: "#fff4df", intensity: 0.35, position: [1.4, 210, 40],
});

export default function DayMapFixture({ showQuest, selectedId, onSelect, bottomInset, rightInset }: {
  showQuest: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  bottomInset: number;
  rightInset: number;
}) {
  return (
    <MapLibreQuestMap initialStyle={dayStyle} me={center} quest={showQuest ? quest : null}
      deck={showQuest ? deck : emptyDeck} selectedId={showQuest ? selectedId : null}
      onSelect={onSelect} bottomInset={bottomInset} rightInset={rightInset} />
  );
}
