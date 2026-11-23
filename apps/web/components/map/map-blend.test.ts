import { describe, expect, it } from "vitest";
import type { LayerSpecification } from "maplibre-gl";
import { mixColors, styleFor } from "./map-blend";
import { mapAppearanceAt } from "./map-daylight";
import { larperOsPhaseStyles } from "./larper-os-style";

const paint = (layers: LayerSpecification[], id: string, prop: string) => {
  const layer = layers.find((l) => l.id === id);
  return layer && "paint" in layer ? (layer.paint as Record<string, unknown>)[prop] : undefined;
};
type Appearance = Parameters<typeof styleFor>[0];
const appearance = (t: number, extra: Partial<Appearance> = {}): Appearance =>
  ({ phase: "dusk", next: "night", t, altitude: 10, azimuth: 250, ...extra });

describe("phase blending", () => {
  it("mixes colours channel by channel", () => {
    expect(mixColors("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixColors("#102030", "#102030", 0.7)).toBe("#102030");
  });

  it("returns the exact palette at t = 0", () => {
    const L = styleFor(appearance(0)).layers;
    expect(paint(L, "paper", "background-color")).toBe("#F2A58F");
    expect(paint(L, "water", "fill-color")).toBe("#8E9BDC");
  });

  it("blends the land, and the height-based building colours stop by stop", () => {
    const L = styleFor(appearance(0.5)).layers;
    expect(paint(L, "paper", "background-color")).toBe(mixColors("#F2A58F", "#251e29", 0.5));
    const colour = paint(L, "buildings-3d", "fill-extrusion-color") as unknown[];
    expect(colour[0]).toBe("interpolate");
    expect(colour[4]).toBe(mixColors("#F8BBC8", "#51414b", 0.5));
    expect(colour[6]).toBe(mixColors("#BBA3E8", "#6a5363", 0.5));
  });

  it("switches labels and halos at the midpoint instead of blending them", () => {
    const text = (t: number) => {
      const L = styleFor(appearance(t)).layers;
      return [paint(L, "street-names", "text-color"), paint(L, "street-names", "text-halo-color"),
        paint(L, "neighbourhoods", "text-color"), paint(L, "water-names", "text-halo-color")];
    };
    expect(text(0.49)).toEqual(["#2A1236", "#F2A58F", "#2A1236", "#F2A58F"]);
    expect(text(0.5)).toEqual(["#f9efe4", "#251e29", "#f9efe4", "#251e29"]);
    expect(text(0.99)).toEqual(text(0.5));
  });

  it("makes buildings solid only in the night palette", () => {
    const opacity = (a: Appearance) =>
      (paint(styleFor(a).layers, "buildings-3d", "fill-extrusion-opacity") as number[])[6];
    expect(opacity(appearance(0, { phase: "night", next: "dawn" }))).toBe(1);
    expect(opacity(appearance(0.9, { phase: "night", next: "dawn" }))).toBe(1);
    expect(opacity(appearance(0.9))).toBe(0.72); // dusk fading toward night stays see-through
    expect(opacity(appearance(0, { phase: "day", next: "golden" }))).toBe(0.72);
  });

  it("lights from the sun, anchored to the map", () => {
    const light = styleFor(appearance(0.25)).light as { anchor: string; position: number[]; color: string };
    expect(light.anchor).toBe("map");
    expect(light.position).toEqual([1.4, 250, 80]);
    expect(light.color).toBe(mixColors("#FF9E7A", "#b9e3e6", 0.25));
  });

  it("never changes the layer list or sources, so a phase change only repaints", () => {
    const ids = (s: { layers: LayerSpecification[] }) => s.layers.map((l) => l.id);
    for (const style of Object.values(larperOsPhaseStyles)) {
      expect(ids(style)).toEqual(ids(larperOsPhaseStyles.day));
    }
    const blended = styleFor(mapAppearanceAt(new Date("2026-06-21T20:40:00-04:00")));
    expect(ids(blended)).toEqual(ids(larperOsPhaseStyles.day));
    expect(blended.sources).toBe(larperOsPhaseStyles.dusk.sources);
  });

  it("reduced motion gives each palette exactly, replaced at the threshold", () => {
    const night = styleFor(mapAppearanceAt(new Date("2026-06-21T21:05:00-04:00"), true)).layers;
    const dusk = styleFor(mapAppearanceAt(new Date("2026-06-21T21:04:00-04:00"), true)).layers;
    expect(paint(night, "paper", "background-color")).toBe("#251e29");
    expect(paint(dusk, "paper", "background-color")).toBe("#F2A58F");
  });
});
