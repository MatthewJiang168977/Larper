import type { ReactNode } from "react";
import { parseClock } from "../nyc-time";
import { LabPhase } from "./lab-phase";

export type LabSearchParams = Promise<{ time?: string }>;

/** ?time=19:30 pins the wallpaper and the window's tint to that NYC time of day. */
export async function LabAuth({ searchParams, children }: { searchParams: LabSearchParams; children: ReactNode }) {
  return <LabPhase minutes={parseClock((await searchParams).time ?? null)}>{children}</LabPhase>;
}
