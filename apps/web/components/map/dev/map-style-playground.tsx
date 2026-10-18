"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MLMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { BUILDING_STYLES, buildingPaint, currentBuildingPaint, type BuildingStyle } from "../building-styles";
import { journalStyle } from "../journal-style";

// Dev-only (app/dev/map-style): the journal map with a switcher for the building
// colours, a few NYC spots to jump to, how many loaded buildings have an OSM colour,
// and the tile properties of a clicked building.
const SPOTS: { name: string; center: [number, number]; zoom: number }[] = [
  { name: "Midtown", center: [-73.9857, 40.7484], zoom: 16 },
  { name: "Washington Sq", center: [-73.9973, 40.7308], zoom: 16.3 },
  { name: "FiDi", center: [-74.0091, 40.7069], zoom: 16 },
  { name: "Park Slope", center: [-73.9776, 40.6721], zoom: 16.4 },
  { name: "Williamsburg", center: [-73.9573, 40.7143], zoom: 16.2 },
];

interface Picked {
  id: string | number | undefined;
  props: Record<string, unknown>;
}

export default function MapStylePlayground() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(false);
  const [style, setStyle] = useState<BuildingStyle>("current");
  const [coverage, setCoverage] = useState<{ total: number; coloured: number } | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lib = await import("maplibre-gl");
      if (cancelled || !containerRef.current) return;
      lib.setWorkerUrl("/maplibre-gl-worker.mjs");
      const map = new lib.Map({
        container: containerRef.current,
        style: journalStyle,
        center: SPOTS[0].center,
        zoom: SPOTS[0].zoom,
        pitch: 55,
        bearing: -20,
        maxPitch: 70,
        attributionControl: { compact: true },
      });
      map.addControl(new lib.NavigationControl({ visualizePitch: true }), "top-right");
      // Buildings in the loaded tiles (deduplicated by id: a building crossing a tile
      // edge appears once per tile), and how many carry a colour.
      map.on("idle", () => {
        const seen = new Map<unknown, boolean>();
        for (const f of map.querySourceFeatures("omt", { sourceLayer: "building" })) {
          seen.set(f.id ?? f, seen.get(f.id ?? f) || f.properties.colour !== undefined);
        }
        setCoverage({ total: seen.size, coloured: [...seen.values()].filter(Boolean).length });
      });
      map.on("click", (e) => {
        const f = map.queryRenderedFeatures(e.point, { layers: ["buildings-3d", "buildings-flat"] })[0];
        setPicked(f ? { id: f.id, props: f.properties } : null);
      });
      mapRef.current = map;
      map.once("load", () => setReady(true));
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const paint = buildingPaint(style, currentBuildingPaint(journalStyle));
    map.setPaintProperty("buildings-flat", "fill-color", paint.flat);
    map.setPaintProperty("buildings-3d", "fill-extrusion-color", paint.extrusion);
  }, [ready, style]);

  const pct = coverage && coverage.total ? Math.round((100 * coverage.coloured) / coverage.total) : null;

  return (
    <div className="fixed inset-0">
      <div ref={containerRef} className="h-full w-full" />
      <aside className="absolute left-3 top-3 w-72 space-y-3 rounded border border-rule bg-paper/95 p-3 text-sm shadow">
        <h1 className="font-semibold">Map style playground (dev only)</h1>
        <fieldset className="space-y-1">
          <legend className="field-label">Buildings</legend>
          {BUILDING_STYLES.map((s) => (
            <label key={s.id} className="flex items-start gap-2">
              <input type="radio" name="style" checked={style === s.id} onChange={() => setStyle(s.id)} />
              <span>
                {s.label}
                <span className="block text-xs opacity-70">{s.note}</span>
              </span>
            </label>
          ))}
          <label className="flex items-start gap-2 opacity-50">
            <input type="radio" name="style" disabled />
            <span>
              Era / type (NYC PLUTO)
              <span className="block text-xs">Not built yet: waiting on the data proposal.</span>
            </span>
          </label>
        </fieldset>
        <div className="flex flex-wrap gap-1">
          {SPOTS.map((s) => (
            <button
              key={s.name}
              className="rounded border border-rule px-2 py-0.5 text-xs"
              onClick={() => mapRef.current?.flyTo({ center: s.center, zoom: s.zoom, pitch: 55, bearing: -20 })}
            >
              {s.name}
            </button>
          ))}
        </div>
        <p className="text-xs" aria-live="polite">
          {coverage
            ? `Loaded tiles: ${coverage.total} buildings, ${coverage.coloured} with an OSM colour (${pct ?? 0}%).`
            : "Loading tiles…"}
        </p>
        {picked && (
          <pre className="max-h-40 overflow-auto rounded bg-black/5 p-2 text-xs">
            {JSON.stringify({ id: picked.id, ...picked.props }, null, 1)}
          </pre>
        )}
        <p className="text-xs opacity-70">Click a building for its tile properties.</p>
      </aside>
    </div>
  );
}
