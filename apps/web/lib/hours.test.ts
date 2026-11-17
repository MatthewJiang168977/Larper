import { describe, expect, it } from "vitest";
import { readConfirmations, readHours } from "./hours";
import { telUrl, webUrl } from "./web-url";

const good = {
  status: "known",
  state: "open",
  today: [{ from: "11:00", to: "24:00", nextDay: true }],
  nextChange: { at: "22:00", day: "today", weekday: "sat", to: "closed" },
  source: "osm",
  sourceUrl: "https://www.openstreetmap.org/node/1",
  fetchedAt: "2026-11-01T00:00:00Z",
  services: [{ kind: "kitchen", state: "open", today: [{ from: "11:00", to: "21:00", nextDay: false }] }],
};

describe("readHours", () => {
  it("keeps good data as it is", () => {
    expect(readHours(good)).toEqual(good);
  });

  it.each([undefined, null, "known", 5, [], {}, { status: "closed" }, { status: "mystery" }])(
    "reads %j as unverified",
    (raw) => expect(readHours(raw)).toEqual({ status: "unverified" }),
  );

  it("reads an unknown state as unknown, never closed", () => {
    for (const state of [undefined, null, "shut", "CLOSED", 3]) {
      expect(readHours({ ...good, state })).toMatchObject({ state: "unknown" });
    }
  });

  it("reads missing or non-array today and services as empty", () => {
    for (const bad of [undefined, null, "x", {}, 4]) {
      expect(readHours({ ...good, today: bad, services: bad })).toMatchObject({ today: [], services: [] });
    }
  });

  it("drops spans that are null or whose ends aren't times", () => {
    const today = [
      null,
      "x",
      { from: "", to: "22:00" },
      { from: "11:00", to: "25:30" },
      { from: "11:00" },
      { from: "11:00", to: "24:00" },
      { from: "17:00", to: "02:00", nextDay: true },
    ];
    expect(readHours({ ...good, today })).toMatchObject({
      today: [
        { from: "11:00", to: "24:00", nextDay: false },
        { from: "17:00", to: "02:00", nextDay: true },
      ],
    });
  });

  it("drops services of an unknown kind or that aren't objects, and reads their state safely", () => {
    const services = [null, 3, { kind: "patio", state: "open", today: [] }, { kind: "bar", state: "weird", today: null }];
    expect(readHours({ ...good, services })).toMatchObject({ services: [{ kind: "bar", state: "unknown", today: [] }] });
  });

  it("keeps nextChange only with a time, state, day and weekday", () => {
    for (const nextChange of [
      null,
      "22:00",
      { at: "2026-11-16T22:00:00Z", to: "closed" },
      { at: "22:00", day: "today", weekday: "sat", to: "soon" },
      { at: 22, day: "today", weekday: "sat", to: "closed" },
    ]) {
      expect(readHours({ ...good, nextChange })).toMatchObject({ nextChange: null });
    }
    // Older API payloads and invalid day metadata still keep the current hours.
    for (const extra of [{}, { day: "yesterday", weekday: "sat" }, { day: "tomorrow", weekday: "funday" }, { day: "tomorrow" }]) {
      const nextChange = { at: "09:00", to: "open", ...extra };
      expect(readHours({ ...good, nextChange })).toEqual({ ...good, nextChange: null });
    }
    const tomorrow = { at: "09:00", day: "tomorrow", weekday: "sun", to: "open" };
    expect(readHours({ ...good, nextChange: tomorrow })).toMatchObject({ nextChange: tomorrow });
  });

  it("keeps an unknown source as it came, and a bad fetchedAt as nothing", () => {
    expect(readHours({ ...good, source: "psychic" })).toMatchObject({ source: "psychic" });
    expect(readHours({ ...good, fetchedAt: null })).toMatchObject({ fetchedAt: "" });
    expect(readHours({ ...good, sourceUrl: 5 })).toMatchObject({ sourceUrl: null });
  });
});

describe("readConfirmations", () => {
  const ok = { count: 3, last: "this_week" };
  it("keeps good data", () => expect(readConfirmations(ok)).toEqual(ok));
  it.each(["this_week", "this_month", "a_while_ago"])("keeps the recency %s", (last) =>
    expect(readConfirmations({ count: 5, last })).toEqual({ count: 5, last }));
  it("reads fewer than 3 people as nothing (the boundary: 2 hides, 3 shows)", () => {
    expect(readConfirmations({ ...ok, count: 2 })).toBeNull();
    expect(readConfirmations({ ...ok, count: 3 })).toEqual({ count: 3, last: "this_week" });
  });
  it.each([
    undefined,
    null,
    "3",
    { ...ok, count: 0 },
    { ...ok, count: 1 },
    { ...ok, count: -1 },
    { ...ok, count: 3.5 },
    { ...ok, count: "3" },
    { ...ok, count: Number.NaN },
    { count: 3 },
    { ...ok, last: null },
    { ...ok, last: "yesterday" },
    { ...ok, last: { day: "tue", part: "evening" } }, // the old, precise shape is never shown
  ])("reads %j as nothing", (raw) => expect(readConfirmations(raw)).toBeNull());
});

describe("webUrl and telUrl", () => {
  it("lets through http(s) addresses only", () => {
    expect(webUrl("https://a.example/x?y=1")).toBe("https://a.example/x?y=1");
    expect(webUrl(" HTTP://a.example ")).toBe("HTTP://a.example");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://a.example", "//a.example", "a.example", "https://", "https://a b", "", null, undefined, 5]) {
      expect(webUrl(bad)).toBeNull();
    }
  });

  it("builds tel: only from a number with digits", () => {
    expect(telUrl("(212) 555-0142")).toBe("tel:2125550142");
    expect(telUrl("+1 212 555 0142")).toBe("tel:+12125550142");
    for (const bad of ["call us", "+", "()", "", null, undefined]) expect(telUrl(bad)).toBeNull();
  });
});
