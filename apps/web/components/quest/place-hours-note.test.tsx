import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PlaceHours } from "@/lib/api";
import { PlaceHoursNote } from "./place-hours-note";

afterEach(cleanup);

const now = new Date("2026-11-16T15:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
type Known = Extract<PlaceHours, { status: "known" }>;
const known = (over: Partial<Known> = {}): Known => ({
  status: "known",
  state: "open",
  today: [{ from: "11:00", to: "22:00", nextDay: false }],
  nextChange: null,
  source: "osm",
  sourceUrl: null,
  fetchedAt: ago(3),
  services: [],
  ...over,
});
const note = (props: Partial<React.ComponentProps<typeof PlaceHoursNote>> = {}) =>
  render(<PlaceHoursNote website={null} phone={null} now={now} {...props} />);
const text = () => screen.getByTestId("place-hours").textContent ?? "";

describe("PlaceHoursNote: unverified", () => {
  it("says so, with the website and phone as links right there", () => {
    note({ hours: { status: "unverified" }, website: "https://cafe.example", phone: "(212) 555-0142" });
    expect(text()).toContain("hours unverified, check before you go");
    const site = screen.getByRole("link", { name: "website" });
    expect(site.getAttribute("href")).toBe("https://cafe.example");
    expect(site.getAttribute("target")).toBe("_blank");
    expect(site.getAttribute("rel")).toBe("noreferrer");
    expect(site.classList).toContain("hit-target");
    const call = screen.getByRole("link", { name: "call" });
    expect(call.getAttribute("href")).toBe("tel:2125550142");
    expect(call.getAttribute("target")).toBeNull();
    expect(call.classList).toContain("hit-target");
  });

  it("is just the text when there's neither", () => {
    note({ hours: { status: "unverified" } });
    expect(text()).toBe("hours unverified, check before you go");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("offers only the one it has", () => {
    note({ website: "https://cafe.example" });
    expect(screen.getByRole("link", { name: "website" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "call" })).toBeNull();
  });

  it("is what a missing hours means, and never says closed", () => {
    note({ hours: undefined, website: "https://cafe.example", phone: "212 555 0142" });
    expect(text()).toContain("hours unverified");
    expect(text().toLowerCase()).not.toContain("closed");
  });

  it("has no live region", () => {
    note({});
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("PlaceHoursNote: right now", () => {
  it("open, with when it closes", () => {
    note({ hours: known({ nextChange: { at: "22:00", day: "today", weekday: "mon", to: "closed" } }) });
    expect(screen.getByText("open now · closes 10 pm")).toBeTruthy();
    expect(screen.getByText("today: 11 am–10 pm")).toBeTruthy();
  });

  it("open, with no change to report", () => {
    note({ hours: known({ nextChange: { at: "09:00", day: "tomorrow", weekday: "tue", to: "open" } }) });
    expect(screen.getByText("open now")).toBeTruthy();
  });

  it("closed, with when it opens", () => {
    note({ hours: known({ state: "closed", nextChange: { at: "17:30", day: "today", weekday: "mon", to: "open" } }) });
    expect(screen.getByText("closed now · opens 5:30 pm")).toBeTruthy();
  });

  it("closed, opening tomorrow: says tomorrow, so 9 am can't be read as this morning", () => {
    note({ hours: known({ state: "closed", nextChange: { at: "09:00", day: "tomorrow", weekday: "tue", to: "open" } }) });
    expect(screen.getByText("closed now · opens tomorrow 9 am")).toBeTruthy();
  });

  it.each([
    ["open", "closed", "22:00"],
    ["closed", "open", "09:00"],
  ] as const)("an older API with no day still shows %s now and today's hours", (state, to, at) => {
    note({ hours: known({ state, nextChange: { at, to } }) });
    expect(screen.getByText(`${state} now`)).toBeTruthy();
    expect(screen.getByText("today: 11 am–10 pm")).toBeTruthy();
  });

  it("open past midnight: closes tomorrow 2 am", () => {
    note({ hours: known({ nextChange: { at: "02:00", day: "tomorrow", weekday: "tue", to: "closed" } }) });
    expect(screen.getByText("open now · closes tomorrow 2 am")).toBeTruthy();
  });

  it("closed, with nothing to say about opening", () => {
    note({ hours: known({ state: "closed", nextChange: { at: "01:00", day: "today", weekday: "mon", to: "closed" } }) });
    expect(screen.getByText("closed now")).toBeTruthy();
  });

  it("unknown (a holiday, say) asks you to check", () => {
    note({ hours: known({ state: "unknown", today: [] }) });
    expect(screen.getByText("hours may differ today, check before you go")).toBeTruthy();
    expect(text()).not.toContain("closed");
    expect(text()).not.toContain("today:");
  });
});

describe("PlaceHoursNote: today", () => {
  it("joins the spans and shows a nextDay one plainly", () => {
    note({
      hours: known({
        today: [
          { from: "11:30", to: "14:00", nextDay: false },
          { from: "17:00", to: "02:00", nextDay: true },
        ],
      }),
    });
    expect(screen.getByText("today: 11:30 am–2 pm, 5 pm–2 am")).toBeTruthy();
  });

  it("writes noon and midnight", () => {
    note({ hours: known({ today: [{ from: "12:00", to: "24:00", nextDay: true }] }) });
    expect(screen.getByText("today: noon–midnight")).toBeTruthy();
  });

  it("says closed today only when it is closed", () => {
    note({ hours: known({ state: "closed", today: [] }) });
    expect(screen.getByText("closed today")).toBeTruthy();
    cleanup();
    note({ hours: known({ state: "open", today: [] }) });
    expect(text()).not.toContain("closed today");
    cleanup();
    note({ hours: known({ state: "unknown", today: [] }) });
    expect(text()).not.toContain("closed today");
  });

  it("lists the kitchen and the bar", () => {
    note({
      hours: known({
        services: [
          { kind: "kitchen", state: "open", today: [{ from: "11:00", to: "21:00", nextDay: false }] },
          { kind: "bar", state: "closed", today: [{ from: "16:00", to: "02:00", nextDay: true }] },
        ],
      }),
    });
    expect(screen.getByText("kitchen: 11 am–9 pm")).toBeTruthy();
    expect(screen.getByText("bar: 4 pm–2 am")).toBeTruthy();
  });

  it("leaves out a service with no hours and no word that it's closed", () => {
    note({ hours: known({ services: [{ kind: "bar", state: "unknown", today: [] }] }) });
    expect(text()).not.toContain("bar:");
  });
});

describe("PlaceHoursNote: source and freshness", () => {
  it("credits OpenStreetMap with a link to the object when there is one", () => {
    note({ hours: known({ sourceUrl: "https://www.openstreetmap.org/node/42" }) });
    const link = screen.getByRole("link", { name: "OpenStreetMap" });
    expect(link.getAttribute("href")).toBe("https://www.openstreetmap.org/node/42");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(text()).toContain("from OpenStreetMap · checked 3 days ago");
  });

  it("links OpenStreetMap to its copyright page without one, or with an address that isn't a web one", () => {
    note({ hours: known() });
    expect(screen.getByRole("link", { name: "OpenStreetMap" }).getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
    cleanup();
    note({ hours: known({ sourceUrl: "javascript:alert(1)" }) });
    expect(screen.getByRole("link", { name: "OpenStreetMap" }).getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
  });

  it("the venue's website links to the page when it has one, else it's text", () => {
    note({ hours: known({ source: "website", sourceUrl: "https://cafe.example/hours" }) });
    expect(screen.getByRole("link", { name: "the venue's website" }).getAttribute("href")).toBe("https://cafe.example/hours");
    cleanup();
    note({ hours: known({ source: "website" }) });
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(text()).toContain("from the venue's website");
  });

  it.each([
    ["nyc_open_data", "from NYC Open Data · checked 3 days ago"],
    ["alltheplaces", "from AllThePlaces · checked 3 days ago"],
    ["manual", "checked by Larper · 3 days ago"],
  ] as const)("names %s", (source, line) => {
    note({ hours: known({ source, sourceUrl: "https://x.example" }) });
    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it.each([
    [0, "checked today"],
    [1, "checked yesterday"],
    [13, "checked 13 days ago"],
    [21, "checked 3 weeks ago"],
    [90, "checked 3 months ago"],
  ])("a %i-day-old check reads '%s'", (days, words) => {
    note({ hours: known({ source: "nyc_open_data", fetchedAt: ago(days) }) });
    expect(text()).toContain(words);
    expect(text()).not.toContain("out of date");
  });

  it("adds a note past 180 days, and not at 180", () => {
    note({ hours: known({ fetchedAt: ago(180) }) });
    expect(text()).not.toContain("may be out of date");
    cleanup();
    note({ hours: known({ fetchedAt: ago(200) }) });
    expect(text()).toContain("checked 6 months ago · may be out of date");
  });
});

describe("PlaceHoursNote: confirmations", () => {
  it("says 3 people, and how recently in coarse words", () => {
    note({ openConfirmations: { count: 3, last: "this_week" } });
    expect(screen.getByText("confirmed open by 3 people, most recently this week")).toBeTruthy();
  });

  it.each([
    ["this_month", "this month"],
    ["a_while_ago", "a while ago"],
  ] as const)("says %s as %s", (last, words) => {
    note({ hours: known(), openConfirmations: { count: 4, last } });
    expect(screen.getByText(`confirmed open by 4 people, most recently ${words}`)).toBeTruthy();
  });

  it("shows nothing below 3 people, even if the API sent it", () => {
    for (const count of [1, 2]) {
      cleanup();
      note({ openConfirmations: { count, last: "this_week" } });
      expect(text()).not.toContain("confirmed");
      expect(text()).not.toContain("most recently");
    }
  });

  it("shows nothing for none, or for null", () => {
    note({ openConfirmations: { count: 0, last: "a_while_ago" } });
    expect(text()).not.toContain("confirmed");
    cleanup();
    note({ openConfirmations: null });
    expect(text()).not.toContain("confirmed");
  });

  it("never shows a weekday or time of day, even from an older API that sends them", () => {
    note({ openConfirmations: { count: 5, last: { day: "tue", part: "evening" } } as never });
    expect(text()).not.toMatch(/tuesday|evening|confirmed/);
  });
});

describe("PlaceHoursNote: malformed data from the API", () => {
  const bad = (raw: unknown, over: Partial<React.ComponentProps<typeof PlaceHoursNote>> = {}) =>
    note({ hours: raw as PlaceHours, ...over });

  it("never crashes, and says nothing is known, for each kind of mess", () => {
    for (const raw of [
      { status: "known" },
      { status: "known", state: "open", today: null, services: undefined },
      { status: "known", state: "open", today: [null, { from: "", to: "25:30" }], services: [null] },
      { status: "weird", state: "closed" },
      null,
    ]) {
      cleanup();
      expect(() => bad(raw)).not.toThrow();
    }
  });

  it("reads an unknown status as unverified, with no 'closed'", () => {
    bad({ status: "weird", state: "closed", today: [] });
    expect(text()).toBe("hours unverified, check before you go");
  });

  it("says closed only for a known hours whose state is exactly closed", () => {
    bad({ ...known({ source: "osm" }), state: "CLOSED" });
    expect(text().toLowerCase()).not.toContain("closed");
    expect(screen.getByText("hours may differ today, check before you go")).toBeTruthy();
  });

  it("shows no today line for spans that can't be read", () => {
    bad({ ...known(), today: [null, { from: "", to: "22:00" }, { from: "11:00", to: "25:30" }] });
    expect(text()).not.toContain("today:");
    expect(text()).not.toContain("closed today");
  });

  it("copes with a missing services list", () => {
    bad({ ...known(), services: undefined });
    expect(screen.getByText("open now")).toBeTruthy();
  });

  it("leaves out the clause when nextChange.at is a timestamp", () => {
    bad(known({ nextChange: { at: "2026-11-16T22:00:00Z", day: "today", weekday: "mon", to: "closed" } }));
    expect(screen.getByText("open now")).toBeTruthy();
  });

  it("names no source for one it doesn't know, but keeps the hours", () => {
    bad({ ...known(), source: "psychic" });
    expect(text()).toContain("today: 11 am–10 pm");
    expect(text()).not.toContain("from ");
    expect(text()).toContain("3 days ago");
  });

  it("shows no age for a missing, garbage or future fetchedAt", () => {
    for (const fetchedAt of [null, undefined, "garbage", "2099-01-01T00:00:00Z"]) {
      cleanup();
      bad({ ...known(), fetchedAt });
      expect(text()).not.toContain("checked");
      expect(text()).not.toContain("out of date");
    }
  });

  it("shows no confirmation line for a broken one", () => {
    for (const oc of [
      { count: 4, last: null },
      { count: 0, last: "this_week" },
      { count: -3, last: "this_week" },
      { count: 3.5, last: "this_week" },
      { count: 4, last: "someday" },
    ]) {
      cleanup();
      note({ openConfirmations: oc as never });
      expect(text()).not.toContain("confirmed");
    }
  });

  it("links only http(s) websites and numbers with digits when unverified", () => {
    note({ website: "javascript:alert(1)", phone: "call us" });
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    cleanup();
    note({ website: "data:text/html,x" });
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});
