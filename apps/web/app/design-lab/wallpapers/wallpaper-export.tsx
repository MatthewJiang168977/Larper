"use client";

// Renders each phase's map style at each wallpaper size and encodes it as WebP no larger than
// the budget. Dev only. With ?save=http://127.0.0.1:<port> each file is POSTed there as
// <name>.webp; the log shows size, quality and where the neighbourhood labels landed.
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import {
  WALLPAPER_MAX_BYTES, WALLPAPER_PHASES, WALLPAPER_SIZES, type WallpaperSize,
} from "@/components/auth/wallpaper-stills";
import { larperOsPhaseStyles } from "@/components/map/larper-os-style";
import { lightPositionFor, type MapPhase } from "@/components/map/map-daylight";
import { homeBearingAt } from "@/lib/regions";

// The East Village, on the street grid.
const CENTER: [number, number] = [-73.9868, 40.7272];
// Desktop sits closer in: fewer, larger buildings keep four times the pixels inside the budget.
const ZOOM: Record<WallpaperSize, number> = { phone: 15.1, desktop: 15.7 };
// A sun typical of each phase: [altitude, azimuth], in degrees.
const SUN: Record<MapPhase, [number, number]> = {
  dawn: [3, 100], day: [50, 180], golden: [8, 255], dusk: [1, 270], night: [-12, 300],
};

async function render(host: HTMLDivElement, phase: MapPhase, size: WallpaperSize) {
  const lib = await import("maplibre-gl");
  lib.setWorkerUrl("/maplibre-gl-worker.mjs");
  const { width, height } = WALLPAPER_SIZES[size];
  host.style.width = `${width}px`;
  host.style.height = `${height}px`;
  const style = larperOsPhaseStyles[phase];
  const [altitude, azimuth] = SUN[phase];
  const map = new lib.Map({
    container: host,
    // Wallpaper, not a map to navigate: no street names, which also keeps it under budget.
    style: {
      ...style,
      layers: style.layers.filter((l) => l.id !== "street-names"),
      light: { ...style.light, position: lightPositionFor(altitude, azimuth) },
    },
    center: CENTER,
    zoom: ZOOM[size],
    pitch: 50,
    bearing: homeBearingAt(CENTER[1], CENTER[0]),
    pixelRatio: 1,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    canvasContextAttributes: { preserveDrawingBuffer: true },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      map.once("idle", () => resolve());
      setTimeout(() => reject(new Error(`${phase}-${size}: the map never went idle`)), 180_000);
    });
    const labels = map.queryRenderedFeatures({ layers: ["neighbourhoods"] }).map((f) => {
      const p = map.project((f.geometry as unknown as { coordinates: [number, number] }).coordinates);
      return `${f.properties.name} @ ${Math.round(p.x)},${Math.round(p.y)}`;
    });
    // Sharpest first. A busy phase that won't fit at a decent quality is softened a little:
    // it's wallpaper behind windows, and that reads better than blocky compression.
    const copy = document.createElement("canvas");
    copy.width = width;
    copy.height = height;
    const ctx = copy.getContext("2d")!;
    for (const blur of [0, 0.6, 1, 1.5]) {
      ctx.filter = blur ? `blur(${blur}px)` : "none";
      ctx.drawImage(map.getCanvas(), 0, 0, width, height);
      for (let quality = 0.86; quality > 0.45; quality -= 0.04) {
        const blob = await new Promise<Blob | null>((r) => copy.toBlob(r, "image/webp", quality));
        if (blob?.type !== "image/webp") throw new Error("this browser can't encode WebP");
        if (blob.size <= WALLPAPER_MAX_BYTES) return { blob, quality, blur, labels: [...new Set(labels)] };
      }
    }
    throw new Error(`${phase}-${size}: over budget even softened`);
  } finally {
    map.remove();
  }
}

export function WallpaperExport() {
  const host = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    if (started.current || !host.current) return;
    started.current = true;
    const say = (line: string) => setLog((l) => [...l, line]);
    const save = new URLSearchParams(location.search).get("save");
    const target = save?.startsWith("http://127.0.0.1:") ? save : null;
    (async () => {
      // ?only=<phase>-<size> renders one file, for browsers that can't keep ten maps going.
      const only = new URLSearchParams(location.search).get("only");
      for (const size of Object.keys(WALLPAPER_SIZES) as WallpaperSize[]) {
        for (const phase of WALLPAPER_PHASES) {
          if (only && only !== `${phase}-${size}`) continue;
          const name = `${phase}-${size}.webp`;
          const { blob, quality, blur, labels } = await render(host.current!, phase, size);
          if (target) await fetch(`${target}/${name}`, { method: "POST", body: await blob.arrayBuffer() });
          say(`${name} ${blob.size} bytes q=${quality.toFixed(2)} blur=${blur} labels: ${labels.join("; ")}`);
        }
      }
      say("done");
    })().catch((e) => say(`failed: ${String(e)}`));
  }, []);

  return (
    <main>
      <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{log.join("\n") || "rendering…"}</pre>
      <div ref={host} />
    </main>
  );
}
