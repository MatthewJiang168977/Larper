import type { ExpressionSpecification, StyleSpecification } from "maplibre-gl";

// Ways to colour the buildings, for comparing in the dev playground
// (app/dev/map-style). "Current" is whatever journal-style.ts paints.
//
// What OpenFreeMap's building layer has (its TileJSON, and z14 tiles decoded over
// NYC): render_height, render_min_height, hide_3d, and colour, which is OSM's
// building:colour passed through as free text: hex ("#5a81a0"), CSS names ("beige",
// "black") and things that aren't colours at all ("brick"). Set on ~70-90% of
// buildings in Midtown and around Washington Square, ~15-25% in the Brooklyn tiles
// checked. No building type, name, age or address. Features carry ids (the OSM id
// with an extra digit).
export type BuildingStyle = "current" | "osm-colour";

export const BUILDING_STYLES: { id: BuildingStyle; label: string; note: string }[] = [
  { id: "current", label: "Current", note: "The journal style's paper tones, paler with height." },
  {
    id: "osm-colour",
    label: "OSM colours",
    note: "OSM building:colour from the tiles where it parses as a colour; the current tone elsewhere.",
  },
];

type Paint = ExpressionSpecification | string;

/** The journal style's own building colours: the fill and the extrusion. */
export function currentBuildingPaint(style: StyleSpecification): { flat: Paint; extrusion: Paint } {
  const layer = (id: string) => style.layers.find((l) => l.id === id) as { paint?: Record<string, Paint> } | undefined;
  const flat = layer("buildings-flat")?.paint?.["fill-color"];
  const extrusion = layer("buildings-3d")?.paint?.["fill-extrusion-color"];
  if (flat === undefined || extrusion === undefined) throw new Error("journal style has no building layers");
  return { flat, extrusion };
}

// The tag where it parses as a colour, else the current paint. Not simply
// ["to-color", tag, fallback]: inside to-color the fallback's interpolate isn't known
// to produce a colour, so its stops parse as strings and the whole paint is rejected.
// So: convert with an unlikely sentinel colour, and let a top-level case (where the
// expected type is colour) pick the current paint when the sentinel comes back.
const SENTINEL = "#fe01fd";
const osmOr = (fallback: Paint): ExpressionSpecification => [
  "let",
  "osm",
  ["to-color", ["coalesce", ["get", "colour"], ""], SENTINEL],
  [
    "case",
    ["==", ["to-string", ["var", "osm"]], ["to-string", ["to-color", SENTINEL]]],
    fallback as ExpressionSpecification,
    ["var", "osm"],
  ],
];

/** Paint for the "buildings-flat" fill-color and the "buildings-3d" fill-extrusion-color. */
export function buildingPaint(style: BuildingStyle, current: { flat: Paint; extrusion: Paint }) {
  if (style === "osm-colour") return { flat: osmOr(current.flat), extrusion: osmOr(current.extrusion) };
  return current;
}
