import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DeckItem, QuestView } from "@/lib/api";
import { hoursSearchUrl, PANEL_W, QuestSheet } from "./quest-sheet";

const reasons = { liked: ["ramen"], rarest: { tag: "hand_pulled_noodles", nearby: 2 }, indie: true };
const place = (id: string, name: string) => ({
  id,
  name,
  lat: 40.73,
  lng: -73.99,
  category: "ramen_restaurant",
  tags: ["ramen", "noodles"],
  distanceM: 100,
  website: null,
  instagram: null,
  phone: null,
});
const quest = (status: QuestView["status"]): QuestView => ({
  id: "q1",
  status,
  score: 1,
  reasons,
  createdAt: "",
  place: place("p1", "Cafe Uno"),
});
const deck: DeckItem[] = [{ score: 0.5, reasons, place: place("p2", "A Very Long Lead Name That Truncates") }];

const sheet = (status: QuestView["status"], over: { onAction?: () => void; onCoveredChange?: () => void; selectedId?: string } = {}) =>
  render(
    <QuestSheet
      quest={quest(status)}
      deck={deck}
      selectedId={over.selectedId ?? "p1"}
      onSelect={vi.fn()}
      onAction={over.onAction ?? vi.fn()}
      busy={false}
      topLimit={120}
      onCoveredChange={over.onCoveredChange ?? vi.fn()}
    />,
  );

const handle = () => screen.getByRole("button", { name: /^Show (more|less)/ });
const rest = () => document.getElementById(handle().getAttribute("aria-controls")!)!;
const expand = () => fireEvent.click(handle());

// matchMedia for the desktop layout (jsdom has none, so the phone sheet is the default).
const desktop = () =>
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: true, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );

describe("QuestSheet on a phone: peek", () => {
  it("shows the place, how far, its category and the main action", () => {
    sheet("offered");
    expect(screen.getByRole("heading", { name: "Cafe Uno" })).toBeTruthy();
    expect(screen.getByText(/ramen restaurant ·/)).toBeTruthy();
    expect(screen.getByText(/about 1 min on foot/)).toBeTruthy();
    const peekPart = handle().parentElement!;
    expect(within(peekPart).getByRole("button", { name: "Accept quest" })).toBeTruthy();
  });

  it("puts I went in peek once the quest is accepted", () => {
    sheet("accepted");
    expect(within(handle().parentElement!).getByRole("button", { name: "I went" })).toBeTruthy();
  });

  it("keeps everything else out of reach until expanded: no chips, links or Skip in peek", () => {
    sheet("offered");
    expect(rest().hasAttribute("inert")).toBe(true);
    const peekPart = handle().parentElement!;
    expect(within(peekPart).queryByRole("navigation", { name: "Leads" })).toBeNull();
    expect(within(peekPart).queryByRole("button", { name: "Skip" })).toBeNull();
    expect(within(peekPart).queryByRole("link", { name: "Check hours" })).toBeNull();
    expect(within(rest()).getByRole("navigation", { name: "Leads" })).toBeTruthy();
  });

  it("reports its peek height to the map once measured", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(150);
    const onCoveredChange = vi.fn();
    sheet("offered", { onCoveredChange });
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 150, left: 0 });
  });
});

describe("QuestSheet on a phone: the handle", () => {
  it("is a real button that says what it will do and whether the sheet is open", () => {
    sheet("offered");
    expect(handle().getAttribute("aria-expanded")).toBe("false");
    expect(handle().getAttribute("aria-label")).toBe("Show more about this place");
    expand();
    expect(handle().getAttribute("aria-expanded")).toBe("true");
    expect(handle().getAttribute("aria-label")).toBe("Show less");
    expect(rest().hasAttribute("inert")).toBe(false);
  });

  it("announces the settled state, politely", () => {
    sheet("offered");
    expand();
    const live = document.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe("Quest details expanded");
    expand();
    expect(live.textContent).toBe("Quest details collapsed");
  });

  it("moves with the arrow keys and Home/End, and Escape closes it", () => {
    sheet("offered");
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(handle().getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(handle(), { key: "Home" });
    expect(handle().getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(handle(), { key: "End" });
    expect(handle().getAttribute("aria-expanded")).toBe("true");

    const link = within(rest()).getByRole("link", { name: "Directions" });
    link.focus();
    fireEvent.keyDown(link, { key: "Escape" });
    expect(handle().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(handle());
  });

  it("toggles on Enter/Space (the button's click, detail 0) every time", () => {
    sheet("offered");
    fireEvent.click(handle(), { detail: 0 });
    expect(handle().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(handle(), { detail: 0 });
    expect(handle().getAttribute("aria-expanded")).toBe("false");
  });

  it("doesn't leave focus on something collapsing hides", () => {
    sheet("offered");
    expand();
    within(rest()).getByRole("link", { name: "Check hours" }).focus();
    act(() => fireEvent.keyDown(handle(), { key: "ArrowDown" }));
    expect(document.activeElement).toBe(handle());
  });

  it("stays at its snap when a new quest arrives (e.g. after Not today)", () => {
    const { rerender } = sheet("accepted");
    expand();
    rerender(
      <QuestSheet
        quest={{ ...quest("offered"), id: "q2", place: place("p3", "Bar Tres") }}
        deck={deck}
        selectedId="p3"
        onSelect={vi.fn()}
        onAction={vi.fn()}
        busy={false}
        topLimit={120}
        onCoveredChange={vi.fn()}
      />,
    );
    expect(handle().getAttribute("aria-expanded")).toBe("true");
  });
});

describe("QuestSheet on a phone: full", () => {
  it("says 'Not today' (not 'Abandon') on an accepted quest, and sets it aside rather than skipping", () => {
    const onAction = vi.fn();
    sheet("accepted", { onAction });
    expand();
    expect(screen.queryByText("Abandon")).toBeNull();
    fireEvent.click(within(rest()).getByRole("button", { name: "Not today" }));
    expect(onAction).toHaveBeenCalledWith("not-today");
    expect(onAction).not.toHaveBeenCalledWith("skip");
  });

  it("keeps Skip on an offered quest as a skip", () => {
    const onAction = vi.fn();
    sheet("offered", { onAction });
    expand();
    fireEvent.click(within(rest()).getByRole("button", { name: "Skip" }));
    expect(onAction).toHaveBeenCalledWith("skip");
  });

  it("explains why this place and lists its tags", () => {
    sheet("offered");
    const why = within(rest()).getByRole("list", { name: "Why this place" });
    expect(why.textContent).toContain("You marked ramen.");
    expect(why.textContent).toContain("1 of 2 hand pulled noodles spots around here.");
    expect(why.textContent).toContain("Independent.");
    expect(rest().textContent).toContain("ramen · noodles");
  });

  it("gives lead chips a 44 px hit area, truncating inside so it isn't clipped", () => {
    sheet("offered");
    for (const name of ["Quest", "1. A Very Long Lead Name That Truncates"]) {
      const chip = screen.getByRole("button", { name });
      expect(chip.classList).toContain("hit-target");
      expect(chip.classList).not.toContain("truncate"); // overflow: hidden would clip ::before
      expect(chip.querySelector(".truncate")).toBeTruthy();
    }
  });

  it("draws the small print in the label ink", () => {
    sheet("offered");
    expect(screen.getByText(/No opening hours yet/).classList).toContain("text-ink-label");
  });

  it("links 'Check hours' to a maps search for the place, with the other links", () => {
    sheet("offered");
    const link = within(rest()).getByRole("link", { name: "Check hours" });
    expect(link.getAttribute("href")).toBe("https://www.google.com/maps/search/Cafe%20Uno/@40.73,-73.99,18z");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.parentElement).toBe(within(rest()).getByRole("link", { name: "Directions" }).parentElement);
  });

  it("shows a lead's note instead of quest actions, and no main action in its peek", () => {
    sheet("offered", { selectedId: "p2" });
    expect(screen.getByText("Lead 1")).toBeTruthy();
    expect(within(handle().parentElement!).queryByRole("button", { name: "Accept quest" })).toBeNull();
    expect(rest().textContent).toContain("A lead, not your quest.");
  });

  it("escapes names that would break the hours URL", () => {
    expect(hoursSearchUrl({ name: "Joe's Pizza / Bar #2 & Co?", lat: 40.7, lng: -74 })).toBe(
      "https://www.google.com/maps/search/Joe's%20Pizza%20%2F%20Bar%20%232%20%26%20Co%3F/@40.7,-74,18z",
    );
  });
});

describe("QuestSheet on desktop", () => {
  it("is a side panel with everything showing and no handle, covering the map's left", () => {
    desktop();
    const onCoveredChange = vi.fn();
    sheet("offered", { onCoveredChange });
    const panel = screen.getByRole("complementary", { name: "Quest details" });
    expect(screen.queryByRole("button", { name: /^Show (more|less)/ })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Accept quest" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Skip" })).toBeTruthy();
    expect(within(panel).getByRole("navigation", { name: "Leads" })).toBeTruthy();
    expect(panel.querySelector("[inert]")).toBeNull();
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 0, left: PANEL_W + 12 });
    vi.unstubAllGlobals();
  });
});
