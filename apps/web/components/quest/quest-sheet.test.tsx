import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckItem, PlaceView, QuestView } from "@/lib/api";
import { formatDistance } from "@/lib/format";
import { hoursSearchUrl, QuestSheet } from "./quest-sheet";
import { DOCK_MIN_WIDTH_PX, DOCK_RESERVED_PX } from "./dock";
import { fullHeight } from "./sheet-snap";

beforeEach(() => vi.stubGlobal("innerWidth", 390));
afterEach(() => vi.unstubAllGlobals());

const reasons = { liked: ["noodles", "ramen"], rarest: { tag: "hand_pulled_noodles", nearby: 2 }, indie: true };
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

const handle = () => screen.getByRole("button", { name: /^Quest details, show (more|less)/ });
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

  it("keeps everything else out of reach until expanded: no chips or links in peek", () => {
    sheet("offered");
    expect(rest().hasAttribute("inert")).toBe(true);
    expect(within(peekPart()).queryByRole("navigation", { name: "Leads" })).toBeNull();
    expect(within(peekPart()).queryByRole("link", { name: "Check hours" })).toBeNull();
    expect(within(rest()).getByRole("navigation", { name: "Leads" })).toBeTruthy();
  });

  it("reports its peek height to the map once measured", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(150);
    const onCoveredChange = vi.fn();
    sheet("offered", { onCoveredChange });
    // The handle strip and peek's content, 150 each in this stub.
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 310, right: 0 });
  });
});

describe("QuestSheet on a phone: the map's inset", () => {
  it("keeps the peek inset when expanded, and reports it again on collapse", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(150);
    const onCoveredChange = vi.fn();
    sheet("offered", { onCoveredChange });
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 310, right: 0 });
    const calls = onCoveredChange.mock.calls.length;
    expand();
    expect(onCoveredChange).toHaveBeenCalledTimes(calls);
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 310, right: 0 });
    expand();
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 310, right: 0 });
  });
});

describe("QuestSheet on a phone: the handle", () => {
  describe("the first-visit hint", () => {
    const HINT = "tap or drag up for details";
    const KEY = "larper:quest-handle-hint-seen";
    let stored: Map<string, string>;
    const show = () => {
      const r = sheet("offered");
      act(() => vi.advanceTimersByTime(30));
      return r;
    };
    beforeEach(() => {
      vi.useFakeTimers();
      stored = new Map();
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      });
    });
    afterEach(() => vi.useRealTimers());

    it("shows on a first visit without marking it seen", () => {
      show();
      expect(screen.getByText(HINT)).toBeTruthy();
      expect(stored.has(KEY)).toBe(false);
    });

    it("shows again after a reload if the sheet was never opened", () => {
      show().unmount();
      show();
      expect(screen.getByText(HINT)).toBeTruthy();
      expect(stored.has(KEY)).toBe(false);
    });

    it("is marked seen and hidden when the handle expands the sheet, and stays gone", () => {
      const first = show();
      expand();
      expect(stored.get(KEY)).toBe("1");
      expect(screen.queryByText(HINT)).toBeNull();
      first.unmount();
      show();
      expect(screen.queryByText(HINT)).toBeNull();
    });

    it("is marked seen by a keyboard expand too", () => {
      show();
      fireEvent.keyDown(handle(), { key: "ArrowUp" });
      expect(stored.get(KEY)).toBe("1");
    });

    it("doesn't mark it seen when collapsing", () => {
      show();
      fireEvent.keyDown(handle(), { key: "ArrowDown" });
      expect(stored.has(KEY)).toBe(false);
    });

    it("shows no hint, and opens fine, when storage is unavailable", () => {
      vi.stubGlobal("localStorage", {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      });
      show();
      expect(screen.queryByText(HINT)).toBeNull();
      expand();
      expect(handle().getAttribute("aria-expanded")).toBe("true");
    });
  });

  it("is a real button that says what it will do and whether the sheet is open", () => {
    sheet("offered");
    expect(handle().getAttribute("aria-expanded")).toBe("false");
    expect(handle().getAttribute("aria-label")).toBe("Quest details, show more");
    expand();
    expect(handle().getAttribute("aria-expanded")).toBe("true");
    expect(handle().getAttribute("aria-label")).toBe("Quest details, show less");
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

  it("tells the page each snap it goes to, and peek again as it goes away", () => {
    const onSnapChange = vi.fn();
    const { unmount } = render(
      <QuestSheet
        quest={quest("offered")}
        deck={deck}
        selectedId="p1"
        onSelect={vi.fn()}
        onAction={vi.fn()}
        busy={false}
        topLimit={120}
        onCoveredChange={vi.fn()}
        onSnapChange={onSnapChange}
      />,
    );
    expect(onSnapChange).toHaveBeenLastCalledWith("peek");
    expand();
    expect(onSnapChange).toHaveBeenLastCalledWith("full");
    unmount();
    expect(onSnapChange).toHaveBeenLastCalledWith("peek");
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

const phoneSecondary = (name: string) => within(peekPart()).getByRole("button", { name });

describe("QuestSheet on a phone: Skip at peek", () => {
  it("puts one secondary Skip button beside Accept and none in full", () => {
    sheet("offered");
    const skip = phoneSecondary("Skip");
    expect(skip.parentElement).toBe(within(peekPart()).getByRole("button", { name: "Accept quest" }).parentElement);
    const classes = skip.className.split(" ");
    expect(classes).toContain("larper-os-button");
    expect(classes).not.toContain("stamp-btn");
    expect(within(rest()).queryByRole("button", { name: "Skip" })).toBeNull();
  });

  it("says 'Not today' (not 'Abandon') on an accepted quest, and sets it aside rather than skipping", () => {
    const onAction = vi.fn();
    sheet("accepted", { onAction });
    expect(screen.queryByText("Abandon")).toBeNull();
    fireEvent.click(phoneSecondary("Not today"));
    expect(onAction).toHaveBeenCalledWith("not-today");
    expect(onAction).not.toHaveBeenCalledWith("skip");
  });

  it("keeps Skip on an offered quest as a skip", () => {
    const onAction = vi.fn();
    sheet("offered", { onAction });
    fireEvent.click(phoneSecondary("Skip"));
    expect(onAction).toHaveBeenCalledWith("skip");
  });
});

describe("QuestSheet on a phone: full", () => {
  it("says what a lead is for: a backup, and lead 1 moves up on a skip", () => {
    sheet("offered", { selectedId: "p2" });
    expect(within(rest()).getByText("A backup nearby. If you skip today's quest, lead 1 moves up.")).toBeTruthy();
    expect(screen.queryByText(/best remaining lead/)).toBeNull();
  });

  it("shows no lead copy on the quest itself", () => {
    sheet("offered");
    expect(screen.queryByText(/A backup nearby/)).toBeNull();
  });

  it("explains why this place and lists its tags", () => {
    sheet("offered");
    const why = within(rest()).getByRole("list", { name: "Why this place" });
    // ramen is dropped: the category (ramen restaurant) already says it.
    expect(why.textContent).toContain("You marked noodles.");
    expect(why.textContent).toContain("1 of 2 hand pulled noodles spots around here.");
    expect(why.textContent).toContain("Independent.");
    expect(rest().textContent).toContain("ramen · noodles");
  });

  it("leaves out the why list when nothing holds up", () => {
    const weak = { liked: ["ramen"], rarest: { tag: "noodles", nearby: 19 }, indie: false };
    render(
      <QuestSheet
        quest={{ ...quest("offered"), reasons: weak }}
        deck={[]}
        selectedId="p1"
        onSelect={vi.fn()}
        onAction={vi.fn()}
        busy={false}
        topLimit={120}
        onCoveredChange={vi.fn()}
      />,
    );
    expand();
    expect(within(rest()).queryByRole("list", { name: "Why this place" })).toBeNull();
    expect(rest().textContent).toContain("ramen · noodles");
  });

  it("gives lead chips a 44 px hit area, truncating inside so it isn't clipped", () => {
    sheet("offered");
    for (const name of ["Quest", "1. A Very Long Lead Name That Truncates"]) {
      const chip = screen.getByRole("button", { name });
      expect(chip.classList).toContain("hit-target");
      expect(chip.classList).not.toContain("truncate"); // overflow: hidden would clip ::before
      expect(chip.textContent).toContain(chip.getAttribute("aria-label") === "Quest" ? "Cafe Uno" : "A Very Long Lead Name That Truncates");
    }
  });

  it("draws the small print in the label ink", () => {
    sheet("offered");
    expect(screen.getByText(/hours unverified, check before you go/).closest("[data-testid=place-hours]")!.classList).toContain("text-ink-label");
  });

  it("links 'Check hours' to a maps search for the place, with the other links", () => {
    sheet("offered");
    const link = within(rest()).getByRole("link", { name: "Check hours" });
    expect(link.getAttribute("href")).toBe("https://www.google.com/maps/search/Cafe%20Uno/@40.73,-73.99,18z");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.parentElement).toBe(within(rest()).getByRole("link", { name: "Directions" }).parentElement);
  });

  it("gives every link a 44 px hit area, spaced so neighbours' areas don't overlap", () => {
    render(
      <QuestSheet
        quest={{ ...quest("offered"), place: { ...place("p1", "Cafe Uno"), website: "https://a.example", instagram: "https://instagram.com/a", phone: "212 555 0100" } }}
        deck={deck}
        selectedId="p1"
        onSelect={vi.fn()}
        onAction={vi.fn()}
        busy={false}
        topLimit={120}
        onCoveredChange={vi.fn()}
      />,
    );
    const links = within(rest().querySelector<HTMLElement>(".larper-quest-links")!).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Directions", "Website", "Instagram", "Call", "Check hours"]);
    for (const link of links) expect(link.classList).toContain("hit-target");
    // 20 px text in a 44 px area reaches 12 px past each edge: 24 px apart either way.
    expect(links[0].parentElement!.className.split(" ")).toEqual(expect.arrayContaining(["gap-x-6", "gap-y-6"]));
  });

  it("shows a lead's note instead of quest actions, and no main action in its peek", () => {
    sheet("offered", { selectedId: "p2" });
    expect(screen.getByText("Lead 1")).toBeTruthy();
    expect(within(peekPart()).queryByRole("button", { name: "Accept quest" })).toBeNull();
    expect(rest().textContent).toContain("A backup nearby.");
  });

  it("escapes names that would break the hours URL", () => {
    expect(hoursSearchUrl({ name: "Joe's Pizza / Bar #2 & Co?", lat: 40.7, lng: -74 })).toBe(
      "https://www.google.com/maps/search/Joe's%20Pizza%20%2F%20Bar%20%232%20%26%20Co%3F/@40.7,-74,18z",
    );
  });
});

describe("QuestSheet on a wide screen: starts open", () => {
  const HINT = "tap or drag up for details";
  const KEY = "larper:quest-handle-hint-seen";
  let stored: Map<string, string>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("innerWidth", 1440);
    stored = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
  });
  afterEach(() => vi.useRealTimers());

  it("mounts at full: expanded, the rest reachable, and the page told so", () => {
    const onSnapChange = vi.fn();
    const onCoveredChange = vi.fn();
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(150);
    render(
      <QuestSheet quest={quest("offered")} deck={deck} selectedId="p1" onSelect={vi.fn()} onAction={vi.fn()} busy={false}
        topLimit={120} onCoveredChange={onCoveredChange} onSnapChange={onSnapChange} />,
    );
    expect(handle().getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("[data-snap]")!.getAttribute("data-snap")).toBe("full");
    expect(rest().hasAttribute("inert")).toBe(false);
    expect(onSnapChange).toHaveBeenCalledTimes(1);
    expect(onSnapChange).toHaveBeenLastCalledWith("full");
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 0, right: DOCK_RESERVED_PX });
  });

  it("opens without announcing, taking focus, showing the hint or marking it seen", () => {
    sheet("offered");
    act(() => vi.advanceTimersByTime(30));
    expect(screen.queryByText("Quest details expanded")).toBeNull();
    expect(document.querySelector("[aria-live]")?.textContent ?? "").toBe("");
    expect(document.activeElement).toBe(document.body);
    expect(screen.queryByText(HINT)).toBeNull();
    expect(stored.has(KEY)).toBe(false);
  });

  it("can be collapsed and expanded by hand; expanding it then writes the key", () => {
    sheet("offered");
    act(() => vi.advanceTimersByTime(30));
    expand();
    expect(handle().getAttribute("aria-expanded")).toBe("false");
    expect(stored.has(KEY)).toBe(false);
    expand();
    expect(handle().getAttribute("aria-expanded")).toBe("true");
    expect(stored.get(KEY)).toBe("1");
  });

  it("does not force the snap when the window is resized across the breakpoint", () => {
    sheet("offered");
    expand();
    vi.stubGlobal("innerWidth", 390);
    act(() => void window.dispatchEvent(new Event("resize")));
    expect(handle().getAttribute("aria-expanded")).toBe("false");
  });

  it("still starts at peek on a phone, one pixel under the dock's minimum", () => {
    vi.stubGlobal("innerWidth", DOCK_MIN_WIDTH_PX - 1);
    sheet("offered");
    expect(handle().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[data-snap]")!.getAttribute("data-snap")).toBe("peek");
  });
});

describe("QuestSheet on a wide screen", () => {
  it("reserves the right dock for the map at either snap", () => {
    vi.stubGlobal("innerWidth", 1440);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(150);
    const onCoveredChange = vi.fn();
    sheet("offered", { onCoveredChange });
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 0, right: DOCK_RESERVED_PX });
    expand(); // starts open: this collapses it
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 0, right: DOCK_RESERVED_PX });
    expect(screen.getByRole("region", { name: "Quest details" })).toBeTruthy();
  });

  it("reserves the dock from exactly the dock's minimum width, and not below it", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(150);
    vi.stubGlobal("innerWidth", DOCK_MIN_WIDTH_PX);
    const wide = vi.fn();
    sheet("offered", { onCoveredChange: wide });
    expect(wide).toHaveBeenLastCalledWith({ bottom: 0, right: DOCK_RESERVED_PX });
    cleanup();
    vi.stubGlobal("innerWidth", DOCK_MIN_WIDTH_PX - 1);
    const narrow = vi.fn();
    sheet("offered", { onCoveredChange: narrow });
    expect(narrow).toHaveBeenLastCalledWith({ bottom: 310, right: 0 });
  });

  it("shows numbered lead rows with category and distance, and a pressed cue", () => {
    vi.stubGlobal("innerWidth", 1440);
    sheet("offered", { selectedId: "p2" });
    const row = screen.getByRole("button", { name: "1. A Very Long Lead Name That Truncates" });
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(row.textContent).toContain("A Very Long Lead Name That Truncates");
    expect(row.textContent).toContain("ramen restaurant · 100 m");
    const questRow = screen.getByRole("button", { name: "Quest" });
    expect(questRow.textContent).toContain("Cafe Uno");
    expect(questRow.querySelector("svg")).toBeTruthy(); // its flag
    expect(questRow.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("link", { name: "Check hours" })).toBeTruthy();
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

  it("colours the label: moss when you arrived, simulated or not; oxblood when not checked in", () => {
    const label = (tone: "done" | "simulated" | "rejected") => {
      const { unmount } = withNote({ tone, label: `L-${tone}`, text: "x" });
      const cls = screen.getByText(`L-${tone}`).className;
      unmount();
      return cls;
    };
    expect(label("done")).toContain("text-moss");
    expect(label("simulated")).toContain("text-moss");
    expect(label("rejected")).toContain("text-oxblood");
  });

  it("is dismissible and shows 'Checking…' while a check is under way", () => {
    const dismiss = vi.fn();
    withNote({ tone: "rejected", label: "Not checked in", text: "x", action: { label: "Check again", onClick: vi.fn(), pending: true } }, dismiss);
    expect(screen.getByRole("button", { name: "Checking…" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismiss).toHaveBeenCalled();
  });
});

describe("QuestSheet: links from the API", () => {
  const withPlace = (over: Partial<PlaceView>) =>
    render(
      <QuestSheet
        quest={{ ...quest("offered"), place: { ...place("p1", "Cafe Uno"), ...over } }}
        deck={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onAction={vi.fn()}
        busy={false}
        topLimit={120}
        onCoveredChange={vi.fn()}
      />,
    );
  const hrefs = () => within(rest()).queryAllByRole("link").map((l) => l.getAttribute("href"));

  it.each(["javascript:alert(1)", "data:text/html,<b>x</b>", "ftp://x.example", "//x.example", "x.example"])(
    "renders no website or instagram link for %s, nor a duplicate in the hours note",
    (bad) => {
      withPlace({ website: bad, instagram: bad });
      expect(hrefs().filter((h) => h === bad)).toEqual([]);
      expect(within(rest()).queryByRole("link", { name: /^website$/i })).toBeNull();
      expect(within(rest()).queryByRole("link", { name: "Instagram" })).toBeNull();
    },
  );

  it("renders a phone with no digits as no call link, in both places", () => {
    withPlace({ phone: "call us" });
    expect(within(rest()).queryByRole("link", { name: /^call$/i })).toBeNull();
    expect(hrefs().some((h) => h?.startsWith("tel:"))).toBe(false);
  });

  it("keeps http(s) links working", () => {
    withPlace({ website: "http://a.example", instagram: "https://instagram.com/a" });
    expect(hrefs()).toEqual(expect.arrayContaining(["http://a.example", "https://instagram.com/a"]));
  });
});

describe("QuestSheet: hours", () => {
  it("shows the hours block in the full view, with the website and phone links when unverified", () => {
    render(
      <QuestSheet
        quest={{ ...quest("offered"), place: { ...place("p1", "Cafe Uno"), website: "https://cafe.example", phone: "212-555-0142" } }}
        deck={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onAction={vi.fn()}
        busy={false}
        topLimit={120}
        onCoveredChange={vi.fn()}
      />,
    );
    const block = within(rest()).getByTestId("place-hours");
    expect(within(block).getByRole("link", { name: "website" }).getAttribute("href")).toBe("https://cafe.example");
    expect(within(block).getByRole("link", { name: "call" }).getAttribute("href")).toBe("tel:2125550142");
    expect(within(rest()).getByRole("link", { name: "Check hours" })).toBeTruthy();
  });
});

describe("QuestSheet: done for today", () => {
  const done = (demo?: boolean) =>
    render(
      <QuestSheet
        quest={quest("completed")}
        deck={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onAction={vi.fn()}
        busy={false}
        topLimit={120}
        onCoveredChange={vi.fn()}
        demo={demo}
      />,
    );

  it("stamps the quest Done in peek, offers no action, and says the next one comes tomorrow", () => {
    done();
    const peek = peekPart();
    expect(within(peek).getByText("Today's quest · done")).toBeTruthy();
    expect(within(peek).getByText("Done")).toBeTruthy();
    expect(within(peek).queryByRole("button", { name: /I went|Accept quest|Skip|Not today/ })).toBeNull();
    expect(peek.textContent).toContain("Done for today. Your next quest comes tomorrow.");
    expect(within(peek).getByRole("link", { name: "Open your journal" }).getAttribute("href")).toBe("/journal");
  });

  it("doesn't promise the demo account a quest tomorrow", () => {
    done(true);
    expect(peekPart().textContent).toContain("That's the demo's quest done. With your own account, the next one comes tomorrow.");
    expect(peekPart().textContent).not.toContain("Done for today.");
  });

  it("asks 'was it open?' under the done message when given the question, and not otherwise", () => {
    done();
    expect(screen.queryByRole("group", { name: "was it open?" })).toBeNull();
    cleanup();
    render(
      <QuestSheet
        quest={quest("completed")}
        deck={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onAction={vi.fn()}
        busy={false}
        topLimit={120}
        onCoveredChange={vi.fn()}
        wasOpen={{ answer: null, onAnswer: vi.fn().mockResolvedValue(undefined) }}
      />,
    );
    const group = within(peekPart()).getByRole("group", { name: "was it open?" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["yes", "no", "didn't check"]);
  });

  it("never asks about a quest that isn't done", () => {
    render(
      <QuestSheet
        quest={quest("accepted")}
        deck={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onAction={vi.fn()}
        busy={false}
        topLimit={120}
        onCoveredChange={vi.fn()}
        wasOpen={{ answer: null, onAnswer: vi.fn() }}
      />,
    );
    expect(screen.queryByRole("group", { name: "was it open?" })).toBeNull();
  });

  it("shows no leads", () => {
    done();
    expect(screen.queryByRole("navigation", { name: "Leads" })).toBeNull();
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
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 194, right: 0 });
    expect(peekPart().style.maxHeight).toBe("");
    expect(body().className).not.toContain("overflow-y-auto");
    expect(rest().className).toContain("overflow-y-auto"); // only the rest scrolls
    vi.unstubAllGlobals();
  });

  it("caps peek at half the screen, scrolling inside, so it never covers the screen", () => {
    stubHeights({ handle: 88, peek: 700, rest: 900 });
    const onCoveredChange = vi.fn();
    sheet("offered", { onCoveredChange });
    expect(onCoveredChange).toHaveBeenLastCalledWith({ bottom: 432, right: 0 });
    expect(peekPart().style.maxHeight).toBe(`${422 - 88}px`);
    expect(peekPart().className).toContain("overflow-y-auto");
    // The name and the main action are in that scrolling part, not cut off below it.
    expect(within(peekPart()).getByRole("heading", { name: "Cafe Uno" })).toBeTruthy();
    expect(within(peekPart()).getByRole("button", { name: "Accept quest" })).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("open, scrolls as one, so the leads and links have room (they had 0 px)", () => {
    stubHeights({ handle: 88, peek: 700, rest: 900 });
    sheet("offered", { selectedId: "p1" });
    expand();
    // As tall as the screen allows below the notices, the whole of it one scroll box.
    expect(section().style.height).toBe(`${fullHeight(834, 120, 422)}px`);
    expect(body().className).toContain("overflow-y-auto");
    expect(peekPart().style.maxHeight).toBe("");
    // The rest isn't squeezed into what peek leaves over: it keeps its own height.
    expect(rest().className).toContain("shrink-0");
    expect(rest().className).not.toContain("flex-1");
    expect(within(rest()).getByRole("navigation", { name: "Leads" })).toBeTruthy();
    expect(within(rest()).getByRole("link", { name: "Check hours" })).toBeTruthy();
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
