import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestView } from "@/lib/api";
import { QuestSheet } from "./quest-sheet";

// The peek's change of place: a short blur-and-slide fade, and a distance that counts
// up. Under reduced motion it just fades: no blur, no slide, and the number is still.
let reduce = false;
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => reduce,
}));

const quest: QuestView = {
  id: "q1",
  status: "offered",
  score: 1,
  reasons: { liked: [], rarest: null, indie: false },
  createdAt: "",
  place: { id: "p1", name: "Cafe Uno", lat: 40.73, lng: -73.99, category: "cafe", tags: [], distanceM: 1340, website: null, instagram: null, phone: null },
};

const sheet = () =>
  render(
    <QuestSheet
      quest={quest}
      deck={[]}
      selectedId="p1"
      onSelect={vi.fn()}
      onAction={vi.fn()}
      busy={false}
      topLimit={120}
      onCoveredChange={vi.fn()}
    />,
  );
// The fade wraps the peek's label, name and distance.
const fade = () => screen.getByRole("heading", { name: "Cafe Uno" }).parentElement!;
const distance = () => screen.getByText(/min on foot/);

beforeEach(() => {
  reduce = false;
});

describe("QuestSheet: the peek's motion", () => {
  it("renders the place and its distance immediately", () => {
    sheet();
    expect(fade().style.filter).toBe("");
    expect(fade().style.transform).toBe("");
    expect(distance().textContent).toContain("· 1,340 m"); // the count starts from 0
  });

  it("with reduced motion: no blur, no slide, and the distance as a plain number", () => {
    reduce = true;
    sheet();
    expect(fade().style.filter).toBe("");
    expect(fade().style.transform).not.toContain("translateY(-4px)");
    expect(distance().textContent).toContain("cafe · 1,340 m, about 17 min on foot");
  });
});
