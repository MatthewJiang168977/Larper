import { describe, expect, it } from "vitest";
import { ageDays, formatAge, formatClock, formatSpan, formatSpans } from "./format";

describe("formatClock", () => {
  it.each([
    ["00:00", "midnight"],
    ["24:00", "midnight"],
    ["12:00", "noon"],
    ["00:30", "12:30 am"],
    ["12:30", "12:30 pm"],
    ["09:05", "9:05 am"],
    ["11:30", "11:30 am"],
    ["17:00", "5 pm"],
    ["23:59", "11:59 pm"],
    ["2:00", "2 am"],
  ])("%s is %s", (from, to) => expect(formatClock(from)).toBe(to));

  it("is null for what isn't a time", () => {
    for (const v of ["", "soon", "25:00", "24:30", "10:75", "25:30", "2026-11-16T10:00:00Z", null, undefined, 5]) {
      expect(formatClock(v)).toBeNull();
    }
  });
});

describe("spans", () => {
  it("writes one, one past midnight, and several", () => {
    expect(formatSpan({ from: "11:00", to: "22:00" })).toBe("11 am–10 pm");
    expect(formatSpan({ from: "17:00", to: "02:00" })).toBe("5 pm–2 am");
    expect(formatSpan({ from: "17:00", to: "24:00" })).toBe("5 pm–midnight");
    expect(formatSpans([{ from: "11:30", to: "14:30" }, { from: "17:00", to: "00:00" }])).toBe("11:30 am–2:30 pm, 5 pm–midnight");
  });

  it("leaves out a span that can't be written", () => {
    expect(formatSpan({ from: "", to: "22:00" })).toBeNull();
    expect(formatSpan({ from: "11:00", to: "25:30" })).toBeNull();
    expect(formatSpans([{ from: "", to: "22:00" }, { from: "17:00", to: "22:00" }])).toBe("5 pm–10 pm");
  });
});

describe("formatAge", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  it.each([
    [0, "today"],
    [1, "yesterday"],
    [2, "2 days ago"],
    [13, "13 days ago"],
    [14, "2 weeks ago"],
    [59, "8 weeks ago"],
    [60, "2 months ago"],
    [200, "6 months ago"],
  ])("%i days is %s", (days, text) => expect(formatAge(ago(days), now)).toBe(text));

  it("calls a little clock skew today, a date well in the future nothing, and a non-date nothing", () => {
    expect(formatAge(ago(-0.5), now)).toBe("today");
    expect(formatAge(ago(-3), now)).toBeNull();
    expect(formatAge("soon", now)).toBeNull();
    expect(ageDays("soon", now)).toBeNull();
    expect(ageDays(ago(200), now)).toBe(200);
  });
});
