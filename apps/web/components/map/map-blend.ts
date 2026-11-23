import type { StyleSpecification } from "maplibre-gl";
import { type MapAppearance, lightPositionFor } from "./map-daylight";
import { larperOsPhaseStyles } from "./larper-os-style";

const HEX = /^#[0-9a-f]{6}$/i;
const channel = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);

export function mixColors(a: string, b: string, t: number) {
  return `#${[0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t)
    .toString(16).padStart(2, "0")).join("")}`;
}

export function luminance(hex: string): number {
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [0, 1, 2].map((i) => f(channel(hex, i) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colors. */
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

export const LABEL_CONTRAST = 4.5;

/**
 * The label color for a ground that is part-way between two palettes: whichever of the two
 * palettes' labels reads better against it. Where even the better one falls short (the
 * ground is a mid-tone), it is pushed toward black or white, the least that gets to 4.5:1.
 */
export function legibleLabel(candidates: [string, string], ground: string) {
  const best = contrast(candidates[0], ground) >= contrast(candidates[1], ground) ? candidates[0] : candidates[1];
  if (contrast(best, ground) >= LABEL_CONTRAST) return best;
  // Each candidate moves toward its own end (dark toward black, light toward white); the one
  // that gets to 4.5:1 in the fewest steps wins. Black and white are each at least 4.58:1
  // against any ground on one side of mid-grey, so one of them always gets there.
  let winner = { steps: Infinity, color: best };
  for (const candidate of candidates) {
    const extreme = luminance(candidate) < 0.18 ? "#000000" : "#ffffff";
    for (let step = 1; step <= 40 && step < winner.steps; step++) {
      const pushed = mixColors(candidate, extreme, step / 40);
      if (contrast(pushed, ground) >= LABEL_CONTRAST) { winner = { steps: step, color: pushed }; break; }
    }
  }
  return winner.color;
}

// Walks two paint values of the same shape (a colour, or an expression such as the
// height-based building colours) and mixes the colours and numbers that differ.
function mix(a: unknown, b: unknown, t: number): unknown {
  if (typeof a === "string" && typeof b === "string" && HEX.test(a) && HEX.test(b)) return mixColors(a, b, t);
  if (typeof a === "number" && typeof b === "number") return a + (b - a) * t;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.map((item, i) => mix(item, b[i], t));
  return a;
}

// Extrusions are solid or see-through by phase, never half-way.
const STEPPED = new Set(["fill-extrusion-opacity"]);
// Label colors aren't blended: each update picks the more legible one for the ground they sit on.
const LABEL_GROUND = { "street-names": "paper", "neighbourhoods": "paper", "water-names": "water" } as const;

const fillOf = (layers: StyleSpecification["layers"], id: string) => {
  const layer = layers.find((l) => l.id === id);
  const paint = (layer && "paint" in layer ? layer.paint : undefined) as Record<string, string> | undefined;
  return paint?.["background-color"] ?? paint?.["fill-color"] as string;
};
const textColorOf = (layers: StyleSpecification["layers"], id: string) => {
  const layer = layers.find((l) => l.id === id);
  return ((layer && "paint" in layer ? layer.paint : undefined) as Record<string, string> | undefined)?.["text-color"] as string;
};

/** The map style for a moment: the phase's palette mixed toward the next, lit from where the sun is. */
export function styleFor({ phase, next, t, altitude, azimuth }: MapAppearance): StyleSpecification {
  const from = larperOsPhaseStyles[phase];
  const to = larperOsPhaseStyles[next];
  const ground = (key: "paper" | "water") =>
    mixColors(fillOf(from.layers, key), fillOf(to.layers, key), t);
  const layers = from.layers.map((layer) => {
    if (!("paint" in layer) || !layer.paint) return layer;
    const target = to.layers.find(({ id }) => id === layer.id);
    const targetPaint = (target && "paint" in target ? target.paint : undefined) as Record<string, unknown> | undefined;
    const paint: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(layer.paint)) {
      const other = targetPaint?.[name];
      if (STEPPED.has(name) || other === undefined || t === 0) paint[name] = value;
      else if (name === "text-color" && layer.id in LABEL_GROUND) {
        paint[name] = legibleLabel(
          [textColorOf(from.layers, layer.id), textColorOf(to.layers, layer.id)],
          ground(LABEL_GROUND[layer.id as keyof typeof LABEL_GROUND]),
        );
      } else paint[name] = mix(value, other, t); // halos blend with the land they match
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
