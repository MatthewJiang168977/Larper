import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DeckItem, QuestView } from "@/lib/api";
import { formatDistance } from "@/lib/format";
import { hoursSearchUrl, QuestSheet } from "./quest-sheet";
import { fullHeight } from "./sheet-snap";

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
const peekPart = () => screen.getByTestId("sheet-peek");

describe("QuestSheet on a phone: peek", () => {
  it("shows the place, how far, its category and the main action", () => {
    sheet("offered");
    expect(within(peekPart()).getByRole("heading", { name: "Cafe Uno" })).toBeTruthy();
    expect(within(peekPart()).getByText(/ramen restaurant ·/)).toBeTruthy();
    expect(within(peekPart()).getByText(/about 1 min on foot/)).toBeTruthy();
    expect(within(peekPart()).getByRole("button", { name: "Accept quest" })).toBeTruthy();
  });

  it("puts I went in peek once the quest is accepted", () => {
    sheet("accepted");
    expect(within(peekPart()).getByRole("button", { name: "I went" })).toBeTruthy();
  });

  it("keeps everything else out of reach until expanded: no chips, links or Skip in peek", () => {
    sheet("offered");
    expect(rest().hasAttribute("inert")).toBe(true);
    expect(within(peekPart()).queryByRole("navigation", { name: "Leads" })).toBeNull();
    // Peek's Skip is for wide screens only: display:none on phones (jsdom applies no CSS).
    const peekSkip = within(peekPart()).getByRole("button", { name: "Skip" });
    expect(peekSkip.className.split(" ")).toEqual(expect.arrayContaining(["hidden", "lg:inline-flex"]));
    expect(within(peekPart()).queryByRole("link", { name: "Check hours" })).toBeNull();
    expect(within(rest()).getByRole("navigation", { name: "Leads" })).toBeTruthy();
  });

  it("reports its peek height to the map once measured", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(150);
    const onCoveredChange = vi.fn();
    sheet("offered", { onCoveredChange });
    // The handle strip and peek's content, 150 each in this stub.
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 300, right: 0 });
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
    expect(within(peekPart()).queryByRole("button", { name: "Accept quest" })).toBeNull();
    expect(rest().textContent).toContain("A lead, not your quest.");
  });

  it("escapes names that would break the hours URL", () => {
    expect(hoursSearchUrl({ name: "Joe's Pizza / Bar #2 & Co?", lat: 40.7, lng: -74 })).toBe(
      "https://www.google.com/maps/search/Joe's%20Pizza%20%2F%20Bar%20%232%20%26%20Co%3F/@40.7,-74,18z",
    );
  });
});

describe("QuestSheet on a wide screen", () => {
  // jsdom has no layout or media queries: these pin the classes that do the work.
  it("is the same bottom sheet, a card centred at the bottom no wider than 36rem", () => {
    sheet("offered");
    const section = screen.getByRole("region", { name: "Quest details" });
    expect(section.className.split(" ")).toContain("inset-x-0");
    expect(section.className.split(" ")).toContain("mx-auto");
    expect(section.className.split(" ")).toContain("max-w-xl");
    expect(handle()).toBeTruthy(); // the same handle, snaps and keys as on a phone
  });

  it("open on a wide screen, tells the map to keep pins left of the card, not behind it", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(150);
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockReturnValue(352); // (1280 - 576) / 2
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
    vi.stubGlobal("innerWidth", 1280); // jsdom: no positioned parent, so the window's width
    const onCoveredChange = vi.fn();
    sheet("offered", { onCoveredChange });
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 300, right: 0 }); // peek
    expect(onCoveredChange).toHaveBeenCalledTimes(1);
    expand();
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 0, right: 1280 - 352 + 24 });
    expand();
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 300, right: 0 });
    vi.unstubAllGlobals();
  });

  it("open on a phone, keeps the peek inset (the map is mostly hidden then)", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(150);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390); // offsetLeft 0: full width
    const onCoveredChange = vi.fn();
    sheet("offered", { onCoveredChange });
    expand();
    expect(onCoveredChange).toHaveBeenCalledTimes(1);
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 300, right: 0 });
  });

  it("is 60% of the screen, at most 960 px", () => {
    sheet("offered");
    const classes = screen.getByRole("region", { name: "Quest details" }).className.split(" ");
    expect(classes).toContain("lg:w-[60vw]");
    expect(classes).toContain("lg:max-w-[960px]");
  });

  it("lays full out in two columns, about 55/45 with a 24 px gap: details left, leads right (phones keep one scrolling row)", () => {
    sheet("offered");
    const nav = screen.getByRole("navigation", { name: "Leads" });
    const grid = nav.parentElement!;
    expect(grid.className).toContain("lg:grid-cols-[minmax(0,11fr)_minmax(0,9fr)]");
    expect(grid.className).toContain("lg:gap-x-6");
    expect(nav.className).toContain("overflow-x-auto"); // phones
    expect(nav.className).toContain("lg:col-start-2");
    expect(nav.className).toContain("lg:flex-col");
    expect(nav.className).toContain("lg:gap-0.5");
    const details = screen.getByRole("list", { name: "Why this place" }).parentElement!;
    expect(details.className).toContain("lg:col-start-1");
    expect(within(details).getByRole("link", { name: "Check hours" })).toBeTruthy();
  });

  it("shows each lead as a compact borderless row: name over category and distance; the selected one stays filled", () => {
    sheet("offered", { selectedId: "p2" });
    const row = screen.getByRole("button", { name: "1. A Very Long Lead Name That Truncates" });
    const classes = row.className.split(" ");
    expect(classes).toEqual(expect.arrayContaining(["rounded-full", "border", "max-w-[11rem]"])); // phones: the pill
    expect(classes).toEqual(expect.arrayContaining(["lg:border-0", "lg:flex", "lg:w-full", "lg:py-1"]));
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(classes).toContain("bg-ink"); // the highlight, on every screen
    expect(row.textContent).toContain("A Very Long Lead Name That Truncates");
    expect(row.textContent).toContain("ramen restaurant · 100 m");
    const quest = screen.getByRole("button", { name: "Quest" });
    expect(quest.textContent).toContain("Cafe Uno"); // the list shows the quest's name too
    expect(quest.querySelector("svg")).toBeTruthy(); // its flag
  });

  it("puts Skip beside Accept in peek on wide screens, and keeps it in full on phones", () => {
    sheet("offered");
    const peekSkip = within(peekPart()).getByRole("button", { name: "Skip" });
    expect(peekSkip.parentElement).toBe(within(peekPart()).getByRole("button", { name: "Accept quest" }).parentElement);
    expect(peekSkip.className).toContain("lg:inline-flex");
    const fullSkip = within(rest()).getByRole("button", { name: "Skip" });
    expect(fullSkip.parentElement!.className).toContain("lg:hidden");
  });

  it("formats distances", () => {
    expect(formatDistance(66)).toBe("66 m");
    expect(formatDistance(999.6)).toBe("1000 m");
    expect(formatDistance(1234)).toBe("1.2 km");
    expect(formatDistance(306_412)).toBe("306 km");
  });
});

describe("QuestSheet: the check-in note", () => {
  const withNote = (note: Parameters<typeof QuestSheet>[0]["note"], onDismissNote = vi.fn()) =>
    render(
      <QuestSheet
        quest={quest("accepted")}
        deck={deck}
        selectedId="p1"
        onSelect={vi.fn()}
        onAction={vi.fn()}
        busy={false}
        topLimit={120}
        onCoveredChange={vi.fn()}
        note={note}
        onDismissNote={onDismissNote}
      />,
    );

  it("shows a rejection beside I went, as an alert, with Check again", () => {
    const again = vi.fn();
    withNote({ tone: "rejected", label: "Not checked in", text: "You're 2.8 km away.", action: { label: "Check again", onClick: again } });
    const alert = within(peekPart()).getByRole("alert");
    expect(alert.textContent).toContain("You're 2.8 km away.");
    fireEvent.click(within(alert).getByRole("button", { name: "Check again" }));
    expect(again).toHaveBeenCalled();
    expect(within(peekPart()).getByRole("button", { name: "I went" })).toBeTruthy(); // same place as the action
  });

  it("labels a simulated demo check-in plainly, as a status", () => {
    withNote({ tone: "simulated", label: "Simulated check-in · demo account", text: "The demo pretended you arrived." });
    const status = within(peekPart()).getByRole("status");
    expect(status.textContent).toContain("Simulated check-in · demo account");
  });

  it("is dismissible and shows 'Checking…' while a check is under way", () => {
    const dismiss = vi.fn();
    withNote({ tone: "rejected", label: "Not checked in", text: "x", action: { label: "Check again", onClick: vi.fn(), pending: true } }, dismiss);
    expect(screen.getByRole("button", { name: "Checking…" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismiss).toHaveBeenCalled();
  });
});

// jsdom has no layout: these give the handle strip, peek's content and the rest's content
// the heights a browser would, on a 390 x 844 phone (no positioned parent: the window).
function stubHeights({ handle: h, peek, rest: r }: { handle: number; peek: number; rest: number }) {
  vi.stubGlobal("innerHeight", 844);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (this.querySelector(":scope > button[aria-controls]")) return h;
    if (this.parentElement?.dataset.testid === "sheet-peek") return peek;
    if (this.parentElement?.previousElementSibling?.getAttribute("data-testid") === "sheet-peek") return r;
    return 0;
  });
}

describe("QuestSheet at 200% text or zoom", () => {
  const section = () => screen.getByRole("region", { name: "Quest details" });
  const body = () => screen.getByTestId("sheet-body");

  it("leaves peek alone when it fits in half the screen", () => {
    stubHeights({ handle: 44, peek: 140, rest: 400 });
    const onCoveredChange = vi.fn();
    sheet("offered", { onCoveredChange });
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 184, right: 0 });
    expect(peekPart().style.maxHeight).toBe("");
    expect(body().className).not.toContain("overflow-y-auto");
    expect(rest().className).toContain("overflow-y-auto"); // only the rest scrolls
    vi.unstubAllGlobals();
  });

  it("caps peek at half the screen, scrolling inside, so it never covers the screen", () => {
    stubHeights({ handle: 88, peek: 700, rest: 900 });
    const onCoveredChange = vi.fn();
    sheet("offered", { onCoveredChange });
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 422, right: 0 });
    expect(peekPart().style.maxHeight).toBe(`${422 - 88}px`);
    expect(peekPart().className).toContain("overflow-y-auto");
    // The name and the main action are in that scrolling part, not cut off below it.
    expect(within(peekPart()).getByRole("heading", { name: "Cafe Uno" })).toBeTruthy();
    expect(within(peekPart()).getByRole("button", { name: "Accept quest" })).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("open, scrolls as one, so the leads, links and Skip have room (they had 0 px)", () => {
    stubHeights({ handle: 88, peek: 700, rest: 900 });
    sheet("offered", { selectedId: "p1" });
    expand();
    // As tall as the screen allows below the notices, the whole of it one scroll box.
    expect(section().style.height).toBe(`${fullHeight(844, 120, 422)}px`);
    expect(body().className).toContain("overflow-y-auto");
    expect(peekPart().style.maxHeight).toBe("");
    // The rest isn't squeezed into what peek leaves over: it keeps its own height.
    expect(rest().className).toContain("shrink-0");
    expect(rest().className).not.toContain("flex-1");
    expect(within(rest()).getByRole("navigation", { name: "Leads" })).toBeTruthy();
    expect(within(rest()).getByRole("link", { name: "Check hours" })).toBeTruthy();
    expect(within(rest()).getByRole("button", { name: "Skip" })).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("keeps the handle outside the scrolling part, and shows peek from the top again on close", () => {
    stubHeights({ handle: 88, peek: 700, rest: 900 });
    sheet("offered");
    expect(body().contains(handle())).toBe(false);
    expand();
    const scrolled = vi.spyOn(Element.prototype, "scrollTop", "set"); // jsdom doesn't scroll
    expand();
    expect(scrolled.mock.contexts).toContain(body());
    expect(scrolled).toHaveBeenCalledWith(0);
    expect(peekPart().style.maxHeight).toBe(`${422 - 88}px`);
    vi.unstubAllGlobals();
  });

  it("puts the main action under the distance when there isn't room beside it", () => {
    sheet("offered");
    const row = within(peekPart()).getByRole("button", { name: "Accept quest" }).parentElement!.parentElement!;
    expect(row.className.split(" ")).toContain("flex-wrap");
    expect(within(row).getByText(/about 1 min on foot/).className).toContain("min-w-[8rem]");
  });
});
