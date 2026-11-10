"use client";

import { useState } from "react";
import { JournalView } from "@/components/larper-os/journal";
import type { JournalEntry } from "@/lib/api";

const states = ["full", "empty", "opening", "error"] as const;
type State = typeof states[number];

const places = [
  { name: "Lady Mendl’s Tea Salon", category: "tea_room", status: "offered", liked: ["tea-house"] },
  { name: "Forbidden Planet", category: "comic_books_store", status: "accepted", liked: ["comics"] },
  { name: "Pho House", category: "restaurant", status: "skipped", liked: ["noodles"] },
  { name: "Hidden Lane Bar", category: "cocktail_bar", status: "completed", liked: ["speakeasy"], simulated: true },
  { name: "Camellia", category: "ramen_restaurant", status: "expired", liked: ["ramen"] },
] satisfies (Pick<JournalEntry, "name" | "category" | "status" | "simulated"> & { liked: string[] })[];

const sample: JournalEntry[] = places.map(({ liked, ...place }, index) => {
  const timestamp = `2026-11-0${8 - index}T18:00:00Z`;
  return {
    ...place, id: String(index),
    createdAt: timestamp, updatedAt: timestamp, reasons: { liked, rarest: null, indie: false },
  };
});

export default function JournalFixture() {
  const [state, setState] = useState<State>("full");
  return (
    <JournalView entries={state === "full" ? sample : state === "empty" ? [] : null}
      error={state === "error" ? "Couldn’t open the journal." : null}
      retry={() => setState("full")}
      mapHref="/design-lab"
      previewControls={
        <label className="larper-journal-preview">
          fixture state
          <select value={state} onChange={(event) => setState(event.target.value as State)}>
            {states.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
      }
    />
  );
}
