import { describe, expect, it } from "vitest";
import { homeBearingAt, regionAt } from "./regions";

describe("regions", () => {
  it("faces Manhattan north anywhere in the NYC region", () => {
    expect(homeBearingAt(40.7359, -73.9906)).toBe(29); // Union Square
    expect(homeBearingAt(40.7549, -73.984)).toBe(29); // the demo's Midtown spot
    expect(homeBearingAt(40.6782, -73.9442)).toBe(29); // Brooklyn: the same region, for now
    expect(regionAt(40.7359, -73.9906)?.id).toBe("nyc");
  });

  it("rests north-up outside every region", () => {
    expect(homeBearingAt(42.3601, -71.0589)).toBe(0); // Boston
    expect(regionAt(42.3601, -71.0589)).toBeNull();
  });

  it("uses the API's half-open box: west and south edges in, east and north out", () => {
    expect(regionAt(40.49, -74.26)?.id).toBe("nyc");
    expect(regionAt(40.92, -74)).toBeNull();
    expect(regionAt(40.7, -73.7)).toBeNull();
  });
});
