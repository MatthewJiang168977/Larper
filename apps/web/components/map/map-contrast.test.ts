import { describe, expect, it } from "vitest";
import type { LayerSpecification } from "maplibre-gl";
import { larperOsDayStyle, larperOsNightStyle } from "./larper-os-style";

// WCAG 1.4.11: the parts of the map a person reads streets from must stand 3:1 against the
// land around them. Day roads are cream on pink, so their outline (the casing) carries it;
// at night the roads themselves do. Map text keeps its 4.5:1 too.

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

const paint = (layers: LayerSpecification[], id: string, prop: string) => {
  const layer = layers.find((l) => l.id === id);
  if (!layer || !("paint" in layer) || !layer.paint) throw new Error(`no layer ${id}`);
  return (layer.paint as Record<string, unknown>)[prop] as string;
};
const background = (layers: LayerSpecification[]) => paint(layers, "paper", "background-color");

describe("map contrast", () => {
  it("day: every road has an outline 3:1 against the paper, drawn under the road", () => {
    const L = larperOsDayStyle.layers;
    for (const road of ["roads-minor", "roads-major"]) {
      const casing = paint(L, `${road}-casing`, "line-color");
      expect(contrast(casing, background(L))).toBeGreaterThanOrEqual(3);
      expect(L.findIndex((l) => l.id === `${road}-casing`)).toBeLessThan(L.findIndex((l) => l.id === road));
    }
  });

  it("night: the roads themselves are 3:1 against the paper and the parks", () => {
    const L = larperOsNightStyle.layers;
    const park = paint(L, "park", "fill-color");
    for (const road of ["roads-minor", "roads-major"]) {
      const ink = paint(L, road, "line-color");
      expect(contrast(ink, background(L))).toBeGreaterThanOrEqual(3);
      expect(contrast(ink, park)).toBeGreaterThanOrEqual(3);
    }
  });

  it("both: every casing layer exists in both palettes, so the switch only repaints", () => {
    const ids = (s: typeof larperOsDayStyle) => s.layers.map((l) => l.id);
    expect(ids(larperOsDayStyle)).toEqual(ids(larperOsNightStyle));
  });
});
