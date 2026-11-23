import { describe, expect, it } from "vitest";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import { larperOsPhaseStyles } from "./larper-os-style";
import { styleFor } from "./map-blend";
import type { MapPhase } from "./map-daylight";

// WCAG 1.4.11: the parts of the map a person reads streets from must stand 3:1 against the
// land around them. Pale roads on pale land get an outline (the casing) that carries it,
// and so do pale buildings (the 2D footprints' edge: extrusions have none, and are shaded
// by the light). Map text keeps its 4.5:1.

export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

const paint = (layers: LayerSpecification[], id: string, prop: string) => {
  const layer = layers.find((l) => l.id === id);
  if (!layer || !("paint" in layer) || !layer.paint) throw new Error(`no layer ${id}`);
  return (layer.paint as Record<string, unknown>)[prop] as string;
};

// The colours a phase's contrast depends on, read from the style itself.
export function colorsOf(style: StyleSpecification) {
  const L = style.layers;
  const building = paint(L, "buildings-3d", "fill-extrusion-color") as unknown as string[];
  return {
    land: paint(L, "paper", "background-color"),
    park: paint(L, "park", "fill-color"),
    water: paint(L, "water", "fill-color"),
    coast: paint(L, "water", "fill-outline-color"),
    street: paint(L, "roads-major", "line-color"),
    casing: paint(L, "roads-major-casing", "line-color"),
    buildingLow: building[4],
    buildingHigh: building[6],
    buildingEdge: paint(L, "buildings-2d", "fill-outline-color"),
    label: paint(L, "street-names", "text-color"),
    halo: paint(L, "street-names", "text-halo-color"),
  };
}

const phases = Object.keys(larperOsPhaseStyles) as MapPhase[];

describe.each(phases)("map contrast: %s", (phase) => {
  const c = colorsOf(larperOsPhaseStyles[phase]);

  it("labels are 4.5:1 against the land, their halo and the buildings", () => {
    for (const ground of [c.land, c.halo, c.buildingLow, c.buildingHigh]) {
      expect(contrast(c.label, ground)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("streets are 3:1 against the land, by the road itself or by its outline", () => {
    expect(Math.max(contrast(c.street, c.land), contrast(c.casing, c.land))).toBeGreaterThanOrEqual(3);
  });

  it("buildings are 3:1 against the land, by the fill or by the footprint edge", () => {
    const best = Math.max(contrast(c.buildingLow, c.land), contrast(c.buildingHigh, c.land), contrast(c.buildingEdge, c.land));
    expect(best).toBeGreaterThanOrEqual(3);
  });

  it("labels read against the streets they run along (night's streets are the known exception)", () => {
    // Night: 3.5:1 against the streets. Street names carry a land-coloured halo, and the
    // streets must also stay 3:1 over the parks, which leaves no room to reach 4.5:1.
    expect(contrast(c.label, c.street)).toBeGreaterThanOrEqual(phase === "night" ? 3.4 : 4.5);
  });
});

describe("map contrast: structure", () => {
  it("every road outline is drawn under its road", () => {
    for (const phase of phases) {
      const L = larperOsPhaseStyles[phase].layers;
      for (const road of ["roads-minor", "roads-major"]) {
        expect(L.findIndex((l) => l.id === `${road}-casing`)).toBeLessThan(L.findIndex((l) => l.id === road));
      }
    }
  });

  it("night: the roads themselves are 3:1 against the land and the parks", () => {
    const c = colorsOf(larperOsPhaseStyles.night);
    expect(contrast(c.street, c.land)).toBeGreaterThanOrEqual(3);
    expect(contrast(c.street, c.park)).toBeGreaterThanOrEqual(3);
  });

  it("night: the water is the darkest surface and its coastline is lighter than it", () => {
    const c = colorsOf(larperOsPhaseStyles.night);
    expect(c.water).toBe("#070B1F");
    for (const surface of [c.land, c.park, c.buildingLow]) {
      expect(luminance(c.water)).toBeLessThan(luminance(surface));
    }
    expect(luminance(c.coast)).toBeGreaterThan(luminance(c.water));
  });

  it("labels stay legible against the blended land at the moment they switch (t just under and over 0.5)", () => {
    const next: Record<MapPhase, MapPhase> = { dawn: "day", day: "golden", golden: "dusk", dusk: "night", night: "dawn" };
    for (const phase of phases) {
      for (const t of [0.49, 0.5]) {
        const c = colorsOf(styleFor({ phase, next: next[phase], t, altitude: 10, azimuth: 200 }));
        // Mid-blend, the land is between two palettes: require at least 3:1 (large-text level).
        expect(contrast(c.label, c.land), `${phase} -> ${next[phase]} at ${t}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
