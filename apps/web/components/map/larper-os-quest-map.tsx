"use client";

import type { QuestMapProps } from "./quest-map";
import MapLibreQuestMap from "./maplibre-quest-map";
import { larperOsDayStyle } from "./larper-os-style";

export default function LarperOsQuestMap(props: QuestMapProps) {
  return <MapLibreQuestMap {...props} initialStyle={larperOsDayStyle} />;
}
