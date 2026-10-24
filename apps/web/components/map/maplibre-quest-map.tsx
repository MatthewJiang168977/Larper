"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MLMap, Marker } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { haloDiameterPx } from "./accuracy-halo";
import { journalStyle } from "./journal-style";
import type { QuestMapProps } from "./quest-map";

const PITCH = 55;
const BEARING = -20;
const MIN_FRAME_ZOOM = 14.8;

// Keep pins clear of the sheet, but never give up more than 45% of the screen (on
// desktop the sheet is a narrow card, not a full-width panel).
export function sheetPadding(bottomInset: number, containerHeight: number) {
  return { top: 90, bottom: Math.min(bottomInset + 30, containerHeight * 0.45), left: 60, right: 60 };
}

// Whether a point on screen sits in the visible part: inside the container minus the
// padding. A pin the sheet grew over fails this.
export function inView(pt: { x: number; y: number }, w: number, h: number, pad: ReturnType<typeof sheetPadding>) {
  return pt.x >= pad.left && pt.x <= w - pad.right && pt.y >= pad.top && pt.y <= h - pad.bottom;
}

export type MapView = "3d" | "2d";
// The camera every move keeps, per view: tilted toward the city, or flat and north-up.
export const VIEW_CAMERA: Record<MapView, { pitch: number; bearing: number }> = {
  "3d": { pitch: 50, bearing: BEARING },
  "2d": { pitch: 0, bearing: 0 },
};
// The toggle names what it will do, not what's showing.
export const VIEW_TOGGLE: Record<MapView, { text: string; label: string }> = {
  "3d": { text: "2D", label: "Switch to flat 2D view" },
  "2d": { text: "3D", label: "Switch to 3D view" },
};

const SVG_NS = "http://www.w3.org/2000/svg";

// The quest marker: a pole and a pennant, stroked in the seal's paper colour.
function flagIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.25");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("data-icon", "flag");
  for (const d of ["M6 21V3", "M6 4h11l-3 4.5 3 4.5H6"]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

// MapLibre markers own the root element's transform for positioning, so each pin is
// an inner element inside a plain wrapper; the inner one can scale freely.
function pinElement(className: string, content: string | Node, title: string, onClick?: (e: MouseEvent) => void) {
  const root = document.createElement("div");
  const pin = document.createElement(onClick ? "button" : "div");
  pin.className = className;
  pin.append(content);
  pin.title = title;
  if (onClick) {
    pin.setAttribute("aria-label", title);
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick(e as MouseEvent);
    });
  }
  root.appendChild(pin);
  return { root, pin };
}

// In 2D the map stays flat and north-up: no gesture tilts or turns it.
function allowRotation(map: MLMap, on: boolean) {
  if (on) {
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.touchPitch.enable();
    map.keyboard.enableRotation();
  } else {
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    map.touchPitch.disable();
    map.keyboard.disableRotation();
  }
}

export default function MapLibreQuestMap({ me, quest, deck, selectedId, onSelect, bottomInset }: QuestMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markersRef = useRef<{ marker: Marker; pin: HTMLElement; placeId: string }[]>([]);
  const meMarkerRef = useRef<Marker | null>(null);
  const haloMarkerRef = useRef<Marker | null>(null);
  const libRef = useRef<typeof import("maplibre-gl") | null>(null);
  const onSelectRef = useRef(onSelect);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<MapView>("3d");
  // Latest position without making camera moves depend on GPS updates (a jittery fix
  // shouldn't yank the camera), and which quest has had its establishing shot. The
  // view is read the same way, so switching it doesn't replay a fly-to.
  const meRef = useRef(me);
  const viewRef = useRef(view);
  // The sheet's height is read the same way: it changes with the card's content, and a
  // change alone mustn't replay the fly-to (that reset zoom and tilt on every resize).
  const bottomInsetRef = useRef(bottomInset);
  const framedQuestRef = useRef<string | null>(null);

  useEffect(() => {
    onSelectRef.current = onSelect;
    meRef.current = me;
    viewRef.current = view;
    bottomInsetRef.current = bottomInset;
  }, [onSelect, me, view, bottomInset]);

  // Create the map once. maplibre-gl touches window, so it's imported client-side only.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lib = await import("maplibre-gl");
      if (cancelled || !containerRef.current) return;
      lib.setWorkerUrl("/maplibre-gl-worker.mjs");
      libRef.current = lib;
      const map = new lib.Map({
        container: containerRef.current,
        style: journalStyle,
        center: [me.lng, me.lat],
        zoom: 15.6,
        pitch: PITCH,
        bearing: BEARING,
        maxPitch: 70,
        attributionControl: { compact: true },
      });
      mapRef.current = map;
      setReady(true);
    })();
    return () => {
      cancelled = true;
      // A remount (Fast Refresh) keeps state: without this, ready stays true and the
      // marker effects never re-run for the new map.
      setReady(false);
      mapRef.current?.remove();
      mapRef.current = null;
      meMarkerRef.current = null;
      haloMarkerRef.current = null;
      markersRef.current = [];
    };
    // Center is only the initial camera; later moves go through fly-to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "You are here" follows location updates: the dot, and under it a halo as wide as
  // the reading's accuracy, re-measured as the zoom changes.
  useEffect(() => {
    const lib = libRef.current;
    const map = mapRef.current;
    if (!ready || !lib || !map) return;
    if (!meMarkerRef.current) {
      // Halo first, so the dot draws on top of it.
      const halo = document.createElement("div");
      halo.className = "pin-me-halo";
      halo.dataset.testid = "me-halo";
      haloMarkerRef.current = new lib.Marker({ element: halo, pitchAlignment: "map", rotationAlignment: "map" })
        .setLngLat([me.lng, me.lat])
        .addTo(map);
      const { root } = pinElement("pin-me", "", "You are here");
      meMarkerRef.current = new lib.Marker({ element: root }).setLngLat([me.lng, me.lat]).addTo(map);
    } else {
      haloMarkerRef.current?.setLngLat([me.lng, me.lat]);
      meMarkerRef.current.setLngLat([me.lng, me.lat]);
    }
    const halo = haloMarkerRef.current!.getElement();
    const sizeHalo = () => {
      const d = haloDiameterPx(me.accuracyM, me.lat, map.getZoom());
      halo.hidden = d === null;
      if (d !== null) halo.style.width = halo.style.height = `${d}px`;
    };
    sizeHalo();
    map.on("zoom", sizeHalo);
    return () => {
      map.off("zoom", sizeHalo);
    };
  }, [ready, me.lat, me.lng, me.accuracyM]);

  // Rebuild quest/lead pins when the deck changes.
  useEffect(() => {
    const lib = libRef.current;
    const map = mapRef.current;
    if (!ready || !lib || !map) return;
    // Hit areas are 44 px, so close pins overlap and the one added later (the quest, or
    // the scaled-up selected pin) would take every tap in the overlap. A tap picks the
    // pin whose centre is nearest instead. A keyboard click has no position (detail 0,
    // clientX/Y 0): it keeps the focused pin.
    const nearestPin = (e: MouseEvent) => {
      if (e.detail === 0 || (e.clientX === 0 && e.clientY === 0)) return null;
      let best: { placeId: string; d: number } | null = null;
      for (const m of markersRef.current) {
        const r = m.pin.getBoundingClientRect();
        const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
        if (!best || d < best.d) best = { placeId: m.placeId, d };
      }
      return best?.placeId ?? null;
    };
    const add = (cls: string, content: string | Node, p: { id: string; name: string; lat: number; lng: number }) => {
      const { root, pin } = pinElement(`${cls} hit-target`, content, p.name, (e) =>
        onSelectRef.current(nearestPin(e) ?? p.id),
      );
      const marker = new lib.Marker({ element: root, anchor: "center" }).setLngLat([p.lng, p.lat]).addTo(map);
      return { marker, pin, placeId: p.id };
    };
    // Quest pin added last so it draws above any lead it overlaps.
    const markers = deck.map((d, i) => add("pin-lead", String(i + 1), d.place));
    if (quest) markers.push(add("pin-quest", flagIcon(), quest.place));
    markersRef.current = markers;
    return () => markers.forEach((m) => m.marker.remove());
  }, [ready, quest, deck]);

  // Focus: highlight the pin and fly to it, leaving room for the sheet.
  useEffect(() => {
    markersRef.current.forEach((m) => (m.pin.dataset.selected = String(m.placeId === selectedId)));
    const map = mapRef.current;
    const target = [quest?.place, ...deck.map((d) => d.place)].find((p) => p?.id === selectedId);
    if (!ready || !map || !target) return;
    const padding = sheetPadding(bottomInsetRef.current, map.getContainer().clientHeight);
    const camera = { ...VIEW_CAMERA[viewRef.current], duration: 1600, essential: false }; // respects prefers-reduced-motion

    // First look at a new quest: frame it together with "you are here" so the walk
    // reads at a glance. Later taps fly straight to the chosen pin.
    if (quest && target.id === quest.place.id && framedQuestRef.current !== quest.id) {
      framedQuestRef.current = quest.id;
      const lib = libRef.current!;
      const { lat, lng } = meRef.current;
      const bounds = new lib.LngLatBounds([lng, lat], [lng, lat]).extend([target.lng, target.lat]);
      const cam = map.cameraForBounds(bounds, { padding, pitch: camera.pitch, bearing: camera.bearing });
      const fits = cam?.zoom !== undefined && cam.zoom >= MIN_FRAME_ZOOM;
      if (fits) {
        // cameraForBounds already offsets its center for the padding.
        map.flyTo({ ...camera, center: cam.center, zoom: Math.min(16.6, cam.zoom!) });
      } else {
        // Too far apart to show both at street scale (narrow phone, long walk): the
        // destination wins. Center between the two, weighted toward the quest so it
        // stays on screen while the view leans toward you.
        const center: [number, number] = [
          target.lng + (lng - target.lng) * 0.35,
          target.lat + (lat - target.lat) * 0.35,
        ];
        map.flyTo({ ...camera, center, zoom: MIN_FRAME_ZOOM, padding });
      }
      return;
    }
    map.flyTo({ ...camera, center: [target.lng, target.lat], zoom: 16.6, padding });
    // bottomInset is read through its ref, so a height change alone doesn't land here.
  }, [ready, selectedId, quest, deck]);

  // The sheet changed height. If the selected pin is now hidden, pan it back into view;
  // zoom, tilt and bearing stay. Otherwise leave the camera alone: setting padding by
  // itself would shift the picture, and the next fly-to passes the new padding anyway.
  const firstInsetRef = useRef(true);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (firstInsetRef.current) {
      firstInsetRef.current = false; // the focus effect's fly-to already used it
      return;
    }
    // Mid-flight (a new quest resizes the card in the same render that starts its
    // fly-to, which already read the new height) or mid-gesture: don't cut in.
    if (map.isMoving()) return; // true for camera animations as well as gestures
    const target = [quest?.place, ...deck.map((d) => d.place)].find((p) => p?.id === selectedId);
    const el = map.getContainer();
    const padding = sheetPadding(bottomInset, el.clientHeight);
    if (target && !inView(map.project([target.lng, target.lat]), el.clientWidth, el.clientHeight, padding)) {
      map.easeTo({ center: [target.lng, target.lat], padding, duration: 450, essential: false });
    }
    // Only a height change runs this; selection changes go through the focus effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, bottomInset]);

  // 2D/3D in place of MapLibre's compass. Either way the bearing resets: north-up when
  // flat, the usual angle when tilted.
  const toggleView = () => {
    const next: MapView = view === "3d" ? "2d" : "3d";
    setView(next);
    const map = mapRef.current;
    if (!map) return;
    allowRotation(map, next === "3d");
    map.easeTo({ ...VIEW_CAMERA[next], duration: 700, essential: false });
  };

  // MapLibre's CSS forces `.maplibregl-map { position: relative }` onto the container,
  // which would cancel `absolute inset-0` and collapse it to zero height. So position
  // a wrapper and give the map a plain full-size child.
  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" aria-label="Map of nearby quests" role="region" />
      {ready && (
        <button
          type="button"
          onClick={toggleView}
          aria-label={VIEW_TOGGLE[view].label}
          title={VIEW_TOGGLE[view].label}
          className="absolute right-3 top-3 z-10 flex h-11 min-w-11 items-center justify-center rounded-full border border-paper-edge bg-paper/90 px-3 font-mono text-xs font-semibold tracking-wider text-ink shadow-sm backdrop-blur"
        >
          {VIEW_TOGGLE[view].text}
        </button>
      )}
    </div>
  );
}
