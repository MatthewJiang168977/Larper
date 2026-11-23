import type { StyleSpecification } from "maplibre-gl";
import { type MapAppearance, lightPositionFor } from "./map-daylight";
import { larperOsPhaseStyles } from "./larper-os-style";

const HEX = /^#[0-9a-f]{6}$/i;
const channel = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);

export function mixColors(a: string, b: string, t: number) {
  return `#${[0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t)
    .toString(16).padStart(2, "0")).join("")}`;
}

// Walks two paint values of the same shape (a colour, or an expression such as the
// height-based building colours) and mixes the colours and numbers that differ.
function mix(a: unknown, b: unknown, t: number): unknown {
  if (typeof a === "string" && typeof b === "string" && HEX.test(a) && HEX.test(b)) return mixColors(a, b, t);
  if (typeof a === "number" && typeof b === "number") return a + (b - a) * t;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.map((item, i) => mix(item, b[i], t));
  return a;
}

// Labels and halos switch at the midpoint instead of blending, so text never sits in a
// colour between two palettes where it could be unreadable.
const SWITCHED = new Set(["text-color", "text-halo-color"]);
// Extrusions are solid or see-through by phase, never half-way.
const STEPPED = new Set(["fill-extrusion-opacity"]);

/** The map style for a moment: the phase's palette mixed toward the next, lit from where the sun is. */
export function styleFor({ phase, next, t, altitude, azimuth }: MapAppearance): StyleSpecification {
  const from = larperOsPhaseStyles[phase];
  const to = larperOsPhaseStyles[next];
  const layers = from.layers.map((layer) => {
    if (!("paint" in layer) || !layer.paint) return layer;
    const target = to.layers.find(({ id }) => id === layer.id);
    const targetPaint = (target && "paint" in target ? target.paint : undefined) as Record<string, unknown> | undefined;
    const paint: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(layer.paint)) {
      const other = targetPaint?.[name];
      paint[name] = STEPPED.has(name) || other === undefined || t === 0 ? value
        : SWITCHED.has(name) ? (t >= 0.5 ? other : value)
        : mix(value, other, t);
    }
    return { ...layer, paint } as typeof layer;
  });
  const a = from.light as { color: string; intensity: number };
  const b = to.light as { color: string; intensity: number };
  return {
    ...from,
    layers,
    light: {
      anchor: "map", // the light stays put when the camera turns
      color: mixColors(a.color, b.color, t),
      intensity: a.intensity + (b.intensity - a.intensity) * t,
      position: lightPositionFor(altitude, azimuth),
    },
  };
}
