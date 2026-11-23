import { expect, it } from "vitest";
import { nycInstant, parseClock } from "./nyc-time";

it("parses HH:MM and rejects everything else", () => {
  expect(parseClock("19:30")).toBe(1170);
  expect(parseClock("7:05")).toBe(425);
  for (const bad of [null, "", "24:00", "12:60", "noon", "1930"]) expect(parseClock(bad)).toBeNull();
});

it("finds the instant NYC clocks read a time, either side of a clock change", () => {
  const noon = (iso: string) => nycInstant(12 * 60, undefined, Date.parse(iso)).toISOString();
  expect(noon("2026-06-21T15:00:00Z")).toBe("2026-06-21T16:00:00.000Z"); // EDT
  expect(noon("2026-12-21T15:00:00Z")).toBe("2026-12-21T17:00:00.000Z"); // EST
  expect(noon("2026-03-08T15:00:00Z")).toBe("2026-03-08T16:00:00.000Z"); // the day clocks spring forward
  expect(noon("2026-11-01T15:00:00Z")).toBe("2026-11-01T17:00:00.000Z"); // the day clocks fall back
});
