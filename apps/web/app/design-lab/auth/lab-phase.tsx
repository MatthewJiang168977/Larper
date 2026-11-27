"use client";

import { useMemo, type ReactNode } from "react";
import { PhaseOverride } from "@/components/auth/auth-wallpaper";
import { mapAppearanceAt } from "@/components/map/map-daylight";
import { nycInstant } from "../nyc-time";

/** Pins the auth pages to the phase of `minutes` past NYC midnight (?time=19:30), so all five can be looked at. */
export function LabPhase({ minutes, children }: { minutes: number | null; children: ReactNode }) {
  const phase = useMemo(() => (minutes === null ? null : mapAppearanceAt(nycInstant(minutes), true).phase), [minutes]);
  return <PhaseOverride value={phase}>{children}</PhaseOverride>;
}
