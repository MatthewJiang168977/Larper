import { describe, expect, it } from "vitest";
import {
  type MapPhase, lightPositionFor, mapAppearanceAt, phaseForSun, southAzimuthToClockwiseFromNorth, sunPosition,
} from "./map-daylight";

const phaseAt = (instant: string) => mapAppearanceAt(new Date(instant)).phase;
const ORDER: MapPhase[] = ["night", "dawn", "day", "golden", "dusk", "night"];

// Walks one NYC day a minute at a time, from 05:00 UTC (midnight or 1 am in New York, still
// night), collecting each change of phase.
function transitions(date: string) {
  const start = Date.parse(`${date}T05:00:00Z`);
  const runs: { phase: MapPhase; at: number }[] = [];
  for (let minute = 0; minute <= 24 * 60; minute++) {
    const at = start + minute * 60_000;
    const { phase } = mapAppearanceAt(new Date(at));
    if (phase !== runs.at(-1)?.phase) runs.push({ phase, at });
  }
  return runs;
}

describe("map phases", () => {
  it.each(["2026-06-21", "2026-12-21", "2026-03-08", "2026-11-01"])(
    "%s: runs night, dawn, day, golden hour, dusk, night, changing as the sun crosses each threshold",
    (date) => {
      const runs = transitions(date);
      expect(runs.map((run) => run.phase)).toEqual(ORDER);
      const thresholds = [-6, 8, 12, 2, -6];
      runs.slice(1).forEach((run, i) => {
        const before = sunPosition(run.at - 60_000).altitude;
        const after = sunPosition(run.at).altitude;
        expect(Math.min(before, after)).toBeLessThanOrEqual(thresholds[i]);
        expect(Math.max(before, after)).toBeGreaterThanOrEqual(thresholds[i]);
      });
    },
  );

  it("uses 8° in the morning and 12° in the afternoon for day", () => {
    expect(phaseForSun(10, true)).toBe("day");
    expect(phaseForSun(10, false)).toBe("golden");
    expect(phaseForSun(7.9, true)).toBe("dawn");
    expect(phaseForSun(12.1, false)).toBe("day");
    expect(phaseForSun(2.1, false)).toBe("golden");
    expect(phaseForSun(1.9, false)).toBe("dusk");
    expect(phaseForSun(-5.9, false)).toBe("dusk");
    expect(phaseForSun(-6.1, false)).toBe("night");
    expect(phaseForSun(-5.9, true)).toBe("dawn");
  });

  // First minute of each phase, from the sun maths (times are NYC wall clock).
  it("summer solstice", () => {
    expect(phaseAt("2026-06-21T04:51:00-04:00")).toBe("night");
    expect(phaseAt("2026-06-21T04:52:00-04:00")).toBe("dawn");
    expect(phaseAt("2026-06-21T06:17:00-04:00")).toBe("dawn");
    expect(phaseAt("2026-06-21T06:18:00-04:00")).toBe("day");
    expect(phaseAt("2026-06-21T19:14:00-04:00")).toBe("day");
    expect(phaseAt("2026-06-21T19:15:00-04:00")).toBe("golden");
    expect(phaseAt("2026-06-21T20:14:00-04:00")).toBe("dusk");
    expect(phaseAt("2026-06-21T21:04:00-04:00")).toBe("dusk");
    expect(phaseAt("2026-06-21T21:05:00-04:00")).toBe("night");
  });

  it("winter solstice", () => {
    expect(phaseAt("2026-12-21T06:45:00-05:00")).toBe("night");
    expect(phaseAt("2026-12-21T06:46:00-05:00")).toBe("dawn");
    expect(phaseAt("2026-12-21T08:15:00-05:00")).toBe("day");
    expect(phaseAt("2026-12-21T15:05:00-05:00")).toBe("day");
    expect(phaseAt("2026-12-21T15:06:00-05:00")).toBe("golden");
    expect(phaseAt("2026-12-21T16:15:00-05:00")).toBe("dusk");
    expect(phaseAt("2026-12-21T17:02:00-05:00")).toBe("dusk");
    expect(phaseAt("2026-12-21T17:03:00-05:00")).toBe("night");
  });

  it("spring-forward day: the skipped hour is night, and the offset change moves nothing", () => {
    expect(phaseAt("2026-03-08T01:59:00-05:00")).toBe("night");
    expect(phaseAt("2026-03-08T03:00:00-04:00")).toBe("night");
    expect(phaseAt("2026-03-08T06:51:00-04:00")).toBe("night");
    expect(phaseAt("2026-03-08T06:52:00-04:00")).toBe("dawn");
    expect(phaseAt("2026-03-08T08:07:00-04:00")).toBe("day");
    expect(phaseAt("2026-03-08T17:47:00-04:00")).toBe("golden");
    expect(phaseAt("2026-03-08T18:41:00-04:00")).toBe("dusk");
    expect(phaseAt("2026-03-08T19:23:00-04:00")).toBe("night");
  });

  it("fall-back day: both copies of the repeated hour are night", () => {
    expect(phaseAt("2026-11-01T01:30:00-04:00")).toBe("night");
    expect(phaseAt("2026-11-01T01:30:00-05:00")).toBe("night");
    expect(phaseAt("2026-11-01T05:57:00-05:00")).toBe("night");
    expect(phaseAt("2026-11-01T05:58:00-05:00")).toBe("dawn");
    expect(phaseAt("2026-11-01T07:18:00-05:00")).toBe("day");
    expect(phaseAt("2026-11-01T15:38:00-05:00")).toBe("golden");
    expect(phaseAt("2026-11-01T16:37:00-05:00")).toBe("dusk");
    expect(phaseAt("2026-11-01T17:21:00-05:00")).toBe("night");
  });

  it("is exact where a phase starts and blends toward the next as the sun moves", () => {
    const at = (iso: string) => mapAppearanceAt(new Date(iso));
    expect(at("2026-06-21T12:00:00-04:00")).toMatchObject({ phase: "day", t: 0 });
    expect(at("2026-06-21T19:14:00-04:00")).toMatchObject({ phase: "day", next: "golden" });
    expect(at("2026-06-21T19:14:00-04:00").t).toBeGreaterThan(0.95); // golden hour is about to begin
    expect(at("2026-06-21T19:15:00-04:00").t).toBeLessThan(0.05);
    expect(at("2026-06-21T20:40:00-04:00")).toMatchObject({ phase: "dusk", next: "night" });
    expect(at("2026-06-21T20:40:00-04:00").t).toBeGreaterThan(0.2);
    expect(at("2026-06-21T20:40:00-04:00").t).toBeLessThan(0.9);
    // Night blends toward dawn only before sunrise, never in the evening.
    expect(at("2026-06-21T23:00:00-04:00").t).toBe(0);
    expect(at("2026-06-21T04:30:00-04:00")).toMatchObject({ phase: "night", next: "dawn" });
  });

  it("reduced motion never blends: each phase stays exact until its threshold", () => {
    for (const iso of ["2026-06-21T04:40:00-04:00", "2026-06-21T05:30:00-04:00", "2026-06-21T19:00:00-04:00",
      "2026-06-21T19:40:00-04:00", "2026-06-21T20:40:00-04:00"]) {
      expect(mapAppearanceAt(new Date(iso), true).t).toBe(0);
    }
    expect(mapAppearanceAt(new Date("2026-06-21T20:40:00-04:00"), true).phase).toBe("dusk");
    expect(mapAppearanceAt(new Date("2026-06-21T21:05:00-04:00"), true).phase).toBe("night");
  });
});

describe("sun direction", () => {
  it("converts a south-based azimuth (suncalc) to clockwise from north", () => {
    const deg = Math.PI / 180;
    expect(southAzimuthToClockwiseFromNorth(0)).toBeCloseTo(180); // due south
    expect(southAzimuthToClockwiseFromNorth(90 * deg)).toBeCloseTo(270); // west
    expect(southAzimuthToClockwiseFromNorth(-90 * deg)).toBeCloseTo(90); // east
    expect(southAzimuthToClockwiseFromNorth(180 * deg)).toBeCloseTo(0); // north
  });

  it("puts the sun east in the morning, south at noon and west in the evening", () => {
    const morning = sunPosition(Date.parse("2026-09-22T08:00:00-04:00"));
    const noon = sunPosition(Date.parse("2026-09-22T12:57:00-04:00"));
    const evening = sunPosition(Date.parse("2026-09-22T17:30:00-04:00"));
    expect(morning.azimuth).toBeGreaterThan(80);
    expect(morning.azimuth).toBeLessThan(120);
    expect(noon.azimuth).toBeGreaterThan(175);
    expect(noon.azimuth).toBeLessThan(185);
    expect(noon.altitude).toBeGreaterThan(48); // 90° minus the latitude, at the equinox
    expect(noon.altitude).toBeLessThan(51);
    expect(evening.azimuth).toBeGreaterThan(240);
    expect(evening.azimuth).toBeLessThan(280);
  });

  it("sets the light radius 1.4, the azimuth, and the angle from vertical clamped to 15-80°", () => {
    expect(lightPositionFor(30, 250)).toEqual([1.4, 250, 60]);
    expect(lightPositionFor(80, 180)).toEqual([1.4, 180, 15]);
    expect(lightPositionFor(-40, 10)).toEqual([1.4, 10, 80]);
  });
});
