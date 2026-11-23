import { Suspense } from "react";
import { larperOsClassName } from "../larper-os";
import { assertDesignLab } from "./assert-design-lab";
import { parseClock } from "./nyc-time";
import { QuestFixture } from "./quest-fixture";

type SearchParams = Promise<{ time?: string }>;

// Reading searchParams is runtime data, so it sits inside Suspense and the rest of the page
// can prerender.
async function Fixture({ searchParams }: { searchParams: SearchParams }) {
  const { time } = await searchParams;
  return <QuestFixture initialClock={parseClock(time ?? null)} />;
}

// ?time=19:30 pins the map to that NYC time of day (the lab is 404 in production).
export default function DesignLab({ searchParams }: { searchParams: SearchParams }) {
  assertDesignLab();
  return (
    <main className={larperOsClassName}>
      <Suspense fallback={null}><Fixture searchParams={searchParams} /></Suspense>
    </main>
  );
}
