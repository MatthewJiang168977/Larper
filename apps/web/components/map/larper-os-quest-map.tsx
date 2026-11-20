"use client";

import { useEffect, useState } from "react";
import type { QuestMapProps } from "./quest-map";
import MapLibreQuestMap from "./maplibre-quest-map";
import { larperOsDayStyle, larperOsNightStyle } from "./larper-os-style";
import { mapStyleAtTime } from "./map-daylight";

export default function LarperOsQuestMap(props: QuestMapProps) {
  const [mode, setMode] = useState(() => mapStyleAtTime(new Date()));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      const now = new Date();
      setMode(mapStyleAtTime(now));
      timer = setTimeout(update, 60_000 - now.getTime() % 60_000);
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  const style = mode === "day" ? larperOsDayStyle : larperOsNightStyle;
  return <MapLibreQuestMap {...props} palette={{ mode, style }} />;
}
