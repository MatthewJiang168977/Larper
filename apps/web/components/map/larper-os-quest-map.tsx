"use client";

import { useEffect, useState } from "react";
import type { QuestMapProps } from "./quest-map";
import MapLibreQuestMap from "./maplibre-quest-map";
import { styleFor } from "./map-blend";
import { mapAppearanceAt } from "./map-daylight";

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const paletteAt = (now: Date) => {
  const appearance = mapAppearanceAt(now, reducedMotion());
  return { mode: appearance.phase, style: styleFor(appearance) };
};

/** `at` pins the clock (the design lab's time override); without it the palette follows real time. */
export default function LarperOsQuestMap({ at, ...props }: QuestMapProps & { at?: Date }) {
  const [palette, setPalette] = useState(() => paletteAt(at ?? new Date()));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      const now = at ?? new Date();
      setPalette(paletteAt(now));
      if (!at) timer = setTimeout(update, 60_000 - now.getTime() % 60_000);
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [at]);

  return <MapLibreQuestMap {...props} palette={palette} />;
}
