"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MLMap, Marker } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { journalStyle } from "./journal-style";
import type { QuestMapProps } from "./quest-map";

const PITCH = 55;
const BEARING = -20;

// MapLibre markers own the root element's transform for positioning, so each pin is
// an inner element inside a plain wrapper; the inner one can scale freely.
function pinElement(className: string, label: string, title: string, onClick?: () => void) {
  const root = document.createElement("div");
  const pin = document.createElement(onClick ? "button" : "div");
  pin.className = className;
  pin.textContent = label;
  pin.title = title;
  if (onClick) {
    pin.setAttribute("aria-label", title);
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
  }
  root.appendChild(pin);
  return { root, pin };
}

export default function MapLibreQuestMap({ me, quest, deck, selectedId, onSelect, bottomInset }: QuestMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markersRef = useRef<{ marker: Marker; pin: HTMLElement; placeId: string }[]>([]);
  const meMarkerRef = useRef<Marker | null>(null);
  const libRef = useRef<typeof import("maplibre-gl") | null>(null);
  const onSelectRef = useRef(onSelect);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

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
      map.addControl(new lib.NavigationControl({ visualizePitch: true, showZoom: false }), "top-right");
      mapRef.current = map;
      setReady(true);
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      meMarkerRef.current = null;
      markersRef.current = [];
    };
    // Center is only the initial camera; later moves go through fly-to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "You are here" dot follows location updates.
  useEffect(() => {
    const lib = libRef.current;
    const map = mapRef.current;
    if (!ready || !lib || !map) return;
    if (!meMarkerRef.current) {
      const { root } = pinElement("pin-me", "", "You are here");
      meMarkerRef.current = new lib.Marker({ element: root }).setLngLat([me.lng, me.lat]).addTo(map);
    } else {
      meMarkerRef.current.setLngLat([me.lng, me.lat]);
    }
  }, [ready, me.lat, me.lng]);

  // Rebuild quest/lead pins when the deck changes.
  useEffect(() => {
    const lib = libRef.current;
    const map = mapRef.current;
    if (!ready || !lib || !map) return;
    const add = (cls: string, label: string, p: { id: string; name: string; lat: number; lng: number }) => {
      const { root, pin } = pinElement(cls, label, p.name, () => onSelectRef.current(p.id));
      const marker = new lib.Marker({ element: root, anchor: "center" }).setLngLat([p.lng, p.lat]).addTo(map);
      return { marker, pin, placeId: p.id };
    };
    // Quest pin added last so it draws above any lead it overlaps.
    const markers = deck.map((d, i) => add("pin-lead", String(i + 1), d.place));
    if (quest) markers.push(add("pin-quest", "!", quest.place));
    markersRef.current = markers;
    return () => markers.forEach((m) => m.marker.remove());
  }, [ready, quest, deck]);

  // Focus: highlight the pin and fly to it, leaving room for the sheet.
  useEffect(() => {
    markersRef.current.forEach((m) => (m.pin.dataset.selected = String(m.placeId === selectedId)));
    const map = mapRef.current;
    const target = [quest?.place, ...deck.map((d) => d.place)].find((p) => p?.id === selectedId);
    if (!ready || !map || !target) return;
    map.flyTo({
      center: [target.lng, target.lat],
      zoom: 16.6,
      pitch: 50,
      bearing: BEARING,
      padding: { top: 40, bottom: bottomInset, left: 0, right: 0 },
      duration: 1600,
      essential: false, // respects prefers-reduced-motion
    });
  }, [ready, selectedId, quest, deck, bottomInset]);

  // MapLibre's CSS forces `.maplibregl-map { position: relative }` onto the container,
  // which would cancel `absolute inset-0` and collapse it to zero height. So position
  // a wrapper and give the map a plain full-size child.
  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" aria-label="Map of nearby quests" role="region" />
    </div>
  );
}
