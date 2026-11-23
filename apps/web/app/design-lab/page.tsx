import { larperOsClassName } from "../larper-os";
import { assertDesignLab } from "./assert-design-lab";
import { parseClock } from "./nyc-time";
import { QuestFixture } from "./quest-fixture";

// ?time=19:30 pins the map to that NYC time of day (the lab is 404 in production).
export default async function DesignLab({ searchParams }: { searchParams: Promise<{ time?: string }> }) {
  assertDesignLab();
  const { time } = await searchParams;
  return <main className={larperOsClassName}><QuestFixture initialClock={parseClock(time ?? null)} /></main>;
}
