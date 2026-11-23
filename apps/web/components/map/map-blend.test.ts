import { describe, expect, it } from "vitest";
import type { LayerSpecification } from "maplibre-gl";
import { contrast, legibleLabel, mixColors, styleFor } from "./map-blend";
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

  it("picks each label color for the ground it is on instead of blending it", () => {
    const label = (t: number) => paint(styleFor(appearance(t)).layers, "street-names", "text-color");
    expect(label(0.05)).toBe("#2A1236"); // dusk's dark label while the land is still dusk-bright
    expect(label(0.95)).toBe("#f9efe4"); // night's light label once the land is dark
    // Only ever dusk's label, night's label, or one of them pushed toward black or white.
    for (let t = 0.01; t < 1; t += 0.01) {
      expect(label(t)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("pushes a label toward black or white when neither palette's label reads on the mid-tone", () => {
    const pushed = legibleLabel(["#2A1236", "#f9efe4"], "#8b6260");
    expect(contrast(pushed, "#8b6260")).toBeGreaterThanOrEqual(4.5);
    expect(legibleLabel(["#2A1236", "#f9efe4"], "#f2a58f")).toBe("#2A1236"); // no push needed
  });

  it("blends halos with the land they match", () => {
    const halo = paint(styleFor(appearance(0.5)).layers, "street-names", "text-halo-color");
    expect(halo).toBe(mixColors("#F2A58F", "#251e29", 0.5));
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
