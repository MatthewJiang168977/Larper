import { describe, expect, it } from "vitest";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import { larperOsPhaseStyles } from "./larper-os-style";
import { contrast, luminance, styleFor } from "./map-blend";
import { type MapPhase, mapAppearanceAt } from "./map-daylight";

// WCAG 1.4.11: the parts of the map a person reads streets from must stand 3:1 against the
// land around them. Pale roads on pale land get an outline (the casing) that carries it,
// and so do pale buildings (the 2D footprints' edge: extrusions have none, and are shaded
// by the light). Map text keeps its 4.5:1.

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

  const blendedLabels = (a: Parameters<typeof styleFor>[0]) => {
    const L = styleFor(a).layers;
    const c = colorsOf(styleFor(a));
    return {
      streets: contrast(c.label, c.land),
      neighbourhoods: contrast(paint(L, "neighbourhoods", "text-color"), c.land),
      water: contrast(paint(L, "water-names", "text-color"), c.water),
    };
  };

  it("no point of any blend has a label under 4.5:1 against its blended land or water", () => {
    const next: Record<MapPhase, MapPhase> = { dawn: "day", day: "golden", golden: "dusk", dusk: "night", night: "dawn" };
    for (const phase of phases) {
      for (let t = 0; t <= 1; t += 0.01) {
        const ratios = blendedLabels({ phase, next: next[phase], t, altitude: 10, azimuth: 200 });
        for (const [kind, ratio] of Object.entries(ratios)) {
          expect(ratio, `${phase} -> ${next[phase]} at t=${t.toFixed(2)} (${kind})`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("no minute-by-minute update on the solstices and both clock-change days goes under 4.5:1", () => {
    for (const date of ["2026-06-21", "2026-12-21", "2026-03-08", "2026-11-01"]) {
      const start = Date.parse(`${date}T05:00:00Z`);
      for (let minute = 0; minute < 24 * 60; minute++) {
        const a = mapAppearanceAt(new Date(start + minute * 60_000));
        for (const [kind, ratio] of Object.entries(blendedLabels(a))) {
          expect(ratio, `${date} +${minute} min (${kind})`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});
