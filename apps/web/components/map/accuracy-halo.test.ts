import { describe, expect, it } from "vitest";
import { HALO_MAX_PX, HALO_MIN_PX, haloDiameterPx, metersPerPixel } from "./accuracy-halo";

describe("accuracy halo", () => {
  it("knows MapLibre's scale: ~0.0746 m/px at the equator, zoom 20 (512 px tiles)", () => {
    expect(metersPerPixel(0, 20)).toBeCloseTo(0.0746, 3);
    expect(metersPerPixel(60, 20)).toBeCloseTo(metersPerPixel(0, 20) / 2, 6);
  });

  it("draws the accuracy radius to scale", () => {
    // Washington Square, zoom 16.6: ~0.6 m/px, so ±40 m is ~134 px across.
    const d = haloDiameterPx(40, 40.73, 16.6)!;
    expect(d).toBe(Math.round(80 / metersPerPixel(40.73, 16.6)));
    expect(d).toBeGreaterThan(HALO_MIN_PX);
    expect(d).toBeLessThan(HALO_MAX_PX);
  });

  it("grows with the zoom and with a rougher fix", () => {
    expect(haloDiameterPx(40, 40.73, 17.6)!).toBeGreaterThan(haloDiameterPx(40, 40.73, 16.6)!);
    expect(haloDiameterPx(80, 40.73, 16.6)!).toBeGreaterThan(haloDiameterPx(40, 40.73, 16.6)!);
  });

  it("clamps: never smaller than the dot can show, never wider than the screen can take", () => {
    expect(haloDiameterPx(3, 40.73, 15)).toBe(HALO_MIN_PX);
    expect(haloDiameterPx(5_000, 40.73, 17)).toBe(HALO_MAX_PX);
  });

  it("shows nothing without a real reading", () => {
    expect(haloDiameterPx(undefined, 40.73, 16)).toBeNull();
    expect(haloDiameterPx(0, 40.73, 16)).toBeNull();
    expect(haloDiameterPx(Number.NaN, 40.73, 16)).toBeNull();
  });
});
