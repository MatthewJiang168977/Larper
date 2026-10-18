import { expression, validateStyleMin, type StylePropertySpecification } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { BUILDING_STYLES, buildingPaint, currentBuildingPaint } from "./building-styles";
import { journalStyle } from "./journal-style";

// Evaluates a building colour the way MapLibre would, for one feature's properties.
const spec = {
  type: "color",
  "property-type": "data-driven",
  expression: { interpolated: true, parameters: ["zoom", "feature"] },
  transition: true,
} as unknown as StylePropertySpecification;
function colourOf(paint: unknown, properties: Record<string, unknown>) {
  const compiled = expression.createPropertyExpression(paint, "fill-extrusion-color", spec);
  if (compiled.result !== "success") throw new Error(compiled.value.map((e) => `${e.key}: ${e.message}`).join("; "));
  const c = compiled.value.evaluate({ zoom: 16 }, { type: "Polygon", properties } as never) as { toString(): string };
  return c.toString();
}

const current = currentBuildingPaint(journalStyle);

describe("building styles", () => {
  it("gives a valid style for every building style (MapLibre would reject the paint otherwise)", () => {
    for (const { id } of BUILDING_STYLES) {
      const paint = buildingPaint(id, current);
      const style = structuredClone(journalStyle);
      for (const layer of style.layers) {
        if (layer.id === "buildings-flat") (layer.paint as Record<string, unknown>)["fill-color"] = paint.flat;
        if (layer.id === "buildings-3d") (layer.paint as Record<string, unknown>)["fill-extrusion-color"] = paint.extrusion;
      }
      expect({ id, errors: validateStyleMin(style).map((e) => e.message) }).toEqual({ id, errors: [] });
    }
  });

  it("'current' is exactly the journal style's paint", () => {
    expect(buildingPaint("current", current)).toEqual(current);
  });

  it("'osm-colour' uses the tag where it's a colour, hex or CSS name", () => {
    const { extrusion } = buildingPaint("osm-colour", current);
    expect(colourOf(extrusion, { colour: "#5a81a0", render_height: 30 })).toBe(colourOf(["to-color", "#5a81a0"], {}));
    expect(colourOf(extrusion, { colour: "beige", render_height: 30 })).toBe(colourOf(["to-color", "beige"], {}));
  });

  it("falls back to the current tone when the tag is missing or not a colour", () => {
    const { extrusion } = buildingPaint("osm-colour", current);
    const plain = colourOf(current.extrusion, { render_height: 30 });
    expect(colourOf(extrusion, { render_height: 30 })).toBe(plain);
    expect(colourOf(extrusion, { colour: "brick", render_height: 30 })).toBe(plain);
  });
});
