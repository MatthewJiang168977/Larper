"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MLMap, Marker, StyleSpecification } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { homeBearingAt } from "@/lib/regions";
import { haloDiameterPx } from "./accuracy-halo";
import { BUILDINGS_3D, buildingVisibility, journalStyle } from "./journal-style";
import type { QuestMapProps } from "./quest-map";

const PITCH = 55;
const MIN_FRAME_ZOOM = 14.8;
// How close a fly-to a single pin gets.
const LEAD_ZOOM = 16.6;
// Right- or Ctrl-drag tilts the 3D view; past this the map turns to sky and is hard to
// read or recover from.
export const MAX_PITCH = 60;


// Keep pins clear of the sheet, but never give up more than 45% of the screen to it.
// Open on a wide screen, the sheet covers the right instead (pins go left of it).
export function sheetPadding(bottomInset: number, containerHeight: number, rightInset = 0) {
  return { top: 90, bottom: Math.min(bottomInset + 30, containerHeight * 0.45), left: 60, right: Math.max(60, rightInset) };
}

// Whether a point on screen sits in the visible part: inside the container minus the
// padding. A pin the sheet grew over fails this.
export function inView(pt: { x: number; y: number }, w: number, h: number, pad: ReturnType<typeof sheetPadding>) {
  return pt.x >= pad.left && pt.x <= w - pad.right && pt.y >= pad.top && pt.y <= h - pad.bottom;
}

export type MapView = "3d" | "2d";
// The tilt every move keeps, per view: toward the city, or flat.
export const VIEW_PITCH: Record<MapView, number> = { "3d": 50, "2d": 0 };
// The camera every move keeps: the view's tilt, facing the region's home bearing (the
// street grid straight on screen; lib/regions.ts).
export const viewCamera = (view: MapView, homeBearing: number) => ({ pitch: VIEW_PITCH[view], bearing: homeBearing });
// The compass's reset: true north up, at the view's tilt.
export const resetCamera = (view: MapView) => ({ bearing: 0, pitch: VIEW_PITCH[view] });
// The toggle names what it will do, not what's showing.
export const VIEW_TOGGLE: Record<MapView, { text: string; label: string }> = {
  "3d": { text: "2D", label: "Switch to flat 2D view" },
  "2d": { text: "3D", label: "Switch to 3D view" },
};

const SVG_NS = "http://www.w3.org/2000/svg";

// Keys that move between pins: a step through them (wrapping), or to the first or last.
const PIN_KEYS: Record<string, 1 | -1 | "first" | "last"> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
  Home: "first",
  End: "last",
};

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

// The place's name on a small paper label under its pin, shown by CSS (globals.css) on
// the selected pin, a keyboard-focused one, and on hover where there is hover. The
// pin's own aria-label already names it, so this is for the eye only.
function nameLabel(name: string) {
  const label = document.createElement("span");
  label.className = "pin-name";
  label.textContent = name;
  label.setAttribute("aria-hidden", "true");
  return label;
}

type LngLat = { lat: number; lng: number };
type Padding = ReturnType<typeof sheetPadding>;

// Web Mercator in world units (0..1 across), as MapLibre lays the world out: 512 px
// wide at zoom 0.
const WORLD_PX = 512;
const LABEL_ROOM = 28;
const NARROW_PX = 600;
const toMerc = ({ lat, lng }: LngLat) => {
  const phi = (lat * Math.PI) / 180;
  return { x: (lng + 180) / 360, y: (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2 };
};
const fromMerc = (x: number, y: number): [number, number] => [
  x * 360 - 180,
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI,
];

// Flying to a lead keeps the quest in view, and you too if that still fits: the camera
// that frames them all in the part of the map the sheet leaves, no closer than a pin's
// usual 16.6. Too far apart for street scale, the lead wins at that scale, with the view
// leaning toward the quest as far as the lead stays well inside. The center goes in the
// padded part (the flight passes the padding).
// (MapLibre's cameraForBounds fits the whole lat/lng rectangle turned by the bearing and
// counts the map's padding twice: about two zoom levels further out than needed.)
export function leadCamera(
  lead: LngLat,
  others: LngLat[][],
  size: { w: number; h: number },
  padding: Padding,
  bearing: number,
): { center: [number, number]; zoom: number } {
  const a = (bearing * Math.PI) / 180;
  const [cos, sin] = [Math.cos(a), Math.sin(a)];
  // Into screen axes: the map turned by its bearing (u right, v down), and back.
  const turn = (p: LngLat) => {
    const m = toMerc(p);
    return { u: m.x * cos + m.y * sin, v: -m.x * sin + m.y * cos };
  };
  const unturn = (u: number, v: number) => fromMerc(u * cos - v * sin, u * sin + v * cos);
  // Room for the selected pin's name label under it. Sideways, a phone lets pins into
  // the side padding (it's still on screen) or almost nothing would fit at street
  // scale; a wide screen keeps them further in, so an edge pin's label isn't cut off.
  const side = size.w < NARROW_PX ? -32 : 40;
  const availW = size.w - padding.left - padding.right - 2 * side;
  const availH = size.h - padding.top - padding.bottom - LABEL_ROOM;
  const l = turn(lead);
  if (availW > 0 && availH > 0) {
    for (const extra of others) {
      const pts = [l, ...extra.map(turn)];
      const us = pts.map((p) => p.u);
      const vs = pts.map((p) => p.v);
      const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
      const zoom = Math.min(
        LEAD_ZOOM,
        Math.log2(availW / ((u1 - u0) * WORLD_PX)),
        Math.log2(availH / ((v1 - v0) * WORLD_PX)),
      );
      if (zoom >= MIN_FRAME_ZOOM) return { center: unturn((u0 + u1) / 2, (v0 + v1) / 2), zoom };
    }
  }
  // The lead no more than 70% of the way from the middle to the padded edge.
  const q = others.at(-1)?.[0];
  if (!q || availW <= 0 || availH <= 0) return { center: [lead.lng, lead.lat], zoom: MIN_FRAME_ZOOM };
  const t = turn(q);
  const px = WORLD_PX * 2 ** MIN_FRAME_ZOOM;
  const [du, dv] = [(t.u - l.u) * px, (t.v - l.v) * px];
  const k = Math.min(1, (availW * 0.35) / Math.abs(du), (availH * 0.35) / Math.abs(dv));
  return { center: unturn(l.u + (t.u - l.u) * k, l.v + (t.v - l.v) * k), zoom: MIN_FRAME_ZOOM };
}

// In 2D the map stays flat and keeps its bearing: no gesture tilts or turns it (and
// maxPitch 0 holds it flat whatever else asks). Only the compass turns it, north-up.
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

export default function MapLibreQuestMap({
  me, quest, deck, selectedId, onSelect, bottomInset, rightInset = 0, bottomCovered = false,
  controlsHost, initialStyle = journalStyle,
}: QuestMapProps & {
  /** Read once when the map mounts. Remount to use a different initial style. */
  initialStyle?: StyleSpecification;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markersRef = useRef<{ marker: Marker; pin: HTMLElement; placeId: string }[]>([]);
  // The same pins in keyboard order: the quest, then the leads by number.
  const pinOrderRef = useRef<{ marker: Marker; pin: HTMLElement; placeId: string }[]>([]);
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
  const rightInsetRef = useRef(rightInset);
  const framedQuestRef = useRef<string | null>(null);

  useEffect(() => {
    onSelectRef.current = onSelect;
    meRef.current = me;
    viewRef.current = view;
    bottomInsetRef.current = bottomInset;
    rightInsetRef.current = rightInset;
  }, [onSelect, me, view, bottomInset, rightInset]);

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
        style: initialStyle,
        center: [me.lng, me.lat],
        zoom: 15.6,
        pitch: PITCH,
        bearing: homeBearingAt(me.lat, me.lng),
        maxPitch: MAX_PITCH,
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
      pinOrderRef.current = [];
    };
    // Style and camera are set on mount. Later camera moves go through fly-to.
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

  // With no pin to frame (loading, an error, nothing here), the camera sits on "you are
  // here": the location the quests are for. The map starts on the first position it gets,
  // and that can change before any quest arrives (the demo account goes to Midtown once
  // /me says it's the demo), so follow it once per new position. Not on every refresh: a
  // map panned by hand isn't pulled back while the same empty answer repeats.
  const centeredOnRef = useRef(`${me.lat},${me.lng}`);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const key = `${me.lat},${me.lng}`;
    if (quest || deck.length) {
      centeredOnRef.current = key; // the focus effect frames the quest from here
      return;
    }
    if (centeredOnRef.current === key) return;
    centeredOnRef.current = key;
    const padding = sheetPadding(bottomInsetRef.current, map.getContainer().clientHeight, rightInsetRef.current);
    map.jumpTo({ ...viewCamera(viewRef.current, homeBearingAt(me.lat, me.lng)), center: [me.lng, me.lat], padding });
  }, [ready, me.lat, me.lng, quest, deck]);

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
      pin.addEventListener("keydown", (e) => pinKey(e as KeyboardEvent, p.id));
      pin.addEventListener("focus", () => showFocused(p));
      pin.after(nameLabel(p.name));
      const marker = new lib.Marker({ element: root, anchor: "center" }).setLngLat([p.lng, p.lat]).addTo(map);
      return { marker, pin, placeId: p.id };
    };
    // The pins are one Tab stop (the selected pin; the focus effect keeps the rest out of
    // the Tab order). Arrow keys go through them in the sheet's order, quest first, and
    // move the selection with the focus. They'd pan the map otherwise: it listens on the
    // pins' parent, so the event stops here.
    const pinKey = (e: KeyboardEvent, id: string) => {
      const step = PIN_KEYS[e.key];
      if (step === undefined || e.altKey || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      const ring = pinOrderRef.current;
      const at = ring.findIndex((m) => m.placeId === id);
      const next = ring[step === "first" ? 0 : step === "last" ? ring.length - 1 : (at + step + ring.length) % ring.length];
      if (!next || next.placeId === id) return;
      next.pin.focus({ preventScroll: true });
      onSelectRef.current(next.placeId);
    };
    // Tabbing onto a pin the map was panned away from: bring it into view (zoom, tilt and
    // bearing stay). Arrow keys select the pin too, and that fly-to takes over.
    const showFocused = (p: { lat: number; lng: number }) => {
      const el = map.getContainer();
      const padding = sheetPadding(bottomInsetRef.current, el.clientHeight, rightInsetRef.current);
      if (!inView(map.project([p.lng, p.lat]), el.clientWidth, el.clientHeight, padding)) {
        map.easeTo({ center: [p.lng, p.lat], padding, duration: 450, essential: false });
      }
    };
    // Quest pin added last so it draws above any lead it overlaps.
    const markers = deck.map((d, i) => add("pin-lead", String(i + 1), d.place));
    if (quest) markers.push(add("pin-quest", flagIcon(), quest.place));
    markersRef.current = markers;
    pinOrderRef.current = quest ? [markers[markers.length - 1], ...markers.slice(0, -1)] : markers;
    return () => markers.forEach((m) => m.marker.remove());
  }, [ready, quest, deck]);

  // Focus: highlight the pin and fly to it, leaving room for the sheet.
  useEffect(() => {
    markersRef.current.forEach((m) => (m.pin.dataset.selected = String(m.placeId === selectedId)));
    // One Tab stop for all the pins: the selected one, else the first.
    const tabStop = pinOrderRef.current.find((m) => m.placeId === selectedId) ?? pinOrderRef.current[0];
    pinOrderRef.current.forEach((m) => (m.pin.tabIndex = m === tabStop ? 0 : -1));
    const map = mapRef.current;
    const target = [quest?.place, ...deck.map((d) => d.place)].find((p) => p?.id === selectedId);
    if (!ready || !map || !target) return;
    const padding = sheetPadding(bottomInsetRef.current, map.getContainer().clientHeight, rightInsetRef.current);
    const home = homeBearingAt(meRef.current.lat, meRef.current.lng);
    const camera = { ...viewCamera(viewRef.current, home), duration: 1600, essential: false }; // respects prefers-reduced-motion

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
    if (quest && target.id !== quest.place.id) {
      const q = quest.place;
      const size = { w: map.getContainer().clientWidth, h: map.getContainer().clientHeight };
      map.flyTo({ ...camera, ...leadCamera(target, [[q, meRef.current], [q]], size, padding, camera.bearing), padding });
      return;
    }
    map.flyTo({ ...camera, center: [target.lng, target.lat], zoom: LEAD_ZOOM, padding });
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
    const padding = sheetPadding(bottomInset, el.clientHeight, rightInset);
    if (target && !inView(map.project([target.lng, target.lat]), el.clientWidth, el.clientHeight, padding)) {
      map.easeTo({ center: [target.lng, target.lat], padding, duration: 450, essential: false });
    }
    // Only a height change runs this; selection changes go through the focus effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, bottomInset, rightInset]);

  // The map credit (a licence requirement) sits above the sheet, not behind it. Beside the
  // open sheet on a wide screen, it wraps to fit the strip of map right of the card. With
  // the sheet open over it (a phone), it's out of sight, so out of the Tab order too.
  useEffect(() => {
    const el = mapRef.current?.getContainer();
    const corner = el?.querySelector<HTMLElement>(".maplibregl-ctrl-bottom-right");
    if (!ready || !el || !corner) return;
    corner.style.bottom = `${bottomInset}px`;
    // rightInset is the card's left edge from the right, plus 24 px; centred, the strip
    // right of it is as wide as the card's left edge is from the left.
    corner.style.maxWidth = rightInset > 0 ? `${Math.max(0, el.clientWidth - (rightInset - 24))}px` : "";
    corner.inert = bottomCovered;
  }, [ready, bottomInset, rightInset, bottomCovered]);

  // 2D/3D beside our own compass (MapLibre's isn't used). Either way the camera goes
  // back to the home bearing, at the new view's tilt.
  const toggleView = () => {
    const next: MapView = view === "3d" ? "2d" : "3d";
    setView(next);
    const map = mapRef.current;
    if (!map) return;
    allowRotation(map, next === "3d");
    if (next === "3d") map.setMaxPitch(MAX_PITCH);
    map.easeTo({ ...viewCamera(next, homeBearingAt(meRef.current.lat, meRef.current.lng)), duration: 700, essential: false });
    // Flat for good once the ease lands (lowering maxPitch first would jump, not ease),
    // unless 3D was picked again meanwhile.
    if (next === "2d") map.once("moveend", () => viewRef.current === "2d" && map.setMaxPitch(0));
  };

  // Buildings follow the view: extruded in 3D, flat outlines in 2D (extrusions seen from
  // straight above lean outward and hide the streets and pins). Swapped as the toggle
  // starts its ease, so the tilt animates over the new layer. Before the style has
  // loaded, the swap waits for it.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const apply = () => {
      for (const [id, visibility] of Object.entries(buildingVisibility(view))) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
      }
    };
    if (map.getLayer(BUILDINGS_3D)) {
      apply();
      return;
    }
    map.once("load", apply);
    return () => {
      map.off("load", apply);
    };
  }, [ready, view]);

  // The compass: its needle always points to true north (it turns against the bearing),
  // and a click puts the map north-up at the view's tilt, however it was turned or
  // tilted. In both views: 2D rests at the home bearing too, and gestures can't turn it.
  const [bearing, setBearing] = useState(() => homeBearingAt(me.lat, me.lng));
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const onRotate = () => setBearing(map.getBearing());
    map.on("rotate", onRotate);
    return () => {
      map.off("rotate", onRotate);
    };
  }, [ready]);
  const resetView = () => mapRef.current?.easeTo({ ...resetCamera(view), duration: 500, essential: false });

  const controls = ready && (
    <div className={controlsHost ? "flex gap-2" : "absolute right-3 top-3 z-10 flex gap-2"}>
      <button
        type="button"
        onClick={resetView}
        aria-label="Reset view: north up"
        title="Reset view: north up"
        className="flex h-11 w-11 items-center justify-center rounded-full border border-paper-edge bg-paper/90 text-ink shadow-sm backdrop-blur"
      >
        {/* A needle pointing north on the map, so it turns against the bearing. */}
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6" style={{ transform: `rotate(${-bearing}deg)` }} data-testid="compass-needle">
          <path d="M12 3 L16 12 L12 10.5 L8 12 Z" fill="var(--oxblood)" />
          <path d="M12 21 L8 12 L12 13.5 L16 12 Z" fill="currentColor" opacity="0.35" />
        </svg>
      </button>
      <button
        type="button"
        onClick={toggleView}
        aria-label={VIEW_TOGGLE[view].label}
        title={VIEW_TOGGLE[view].label}
        className="flex h-11 min-w-11 items-center justify-center rounded-full border border-paper-edge bg-paper/90 px-3 font-mono text-xs font-semibold tracking-wider text-ink shadow-sm backdrop-blur"
      >
        {VIEW_TOGGLE[view].text}
      </button>
    </div>
  );

  // MapLibre's CSS forces `.maplibregl-map { position: relative }` onto the container,
  // which would cancel `absolute inset-0` and collapse it to zero height. So position
  // a wrapper and give the map a plain full-size child.
  return (
    // z-0: the page puts the map after its header and sheet (so they come first in the Tab
    // order); this keeps MapLibre's own layers under them all the same.
    <div className="absolute inset-0 z-0">
      <div ref={containerRef} className="h-full w-full" aria-label="Map of nearby quests" role="region" />
      {/* In the page's top bar when it gives a place for them (they wrap below its pill
          when both don't fit); otherwise top right, level with the header. */}
      {controls && (controlsHost ? createPortal(controls, controlsHost) : controls)}
    </div>
  );
}
