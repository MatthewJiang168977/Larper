"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

export interface Located {
  lat: number;
  lng: number;
  source: "gps" | "override" | "demo";
  note?: string;
}

// Washington Square Park: the demo spot when GPS is unavailable or denied.
const DEMO = { lat: 40.7308, lng: -73.9973 };
// Module-level so it's the same object every render (callers use it as an effect dep).
const NO_GPS: Located = { ...DEMO, source: "demo", note: "No GPS on this device. Showing Washington Square." };
// Ignore GPS jitter; only report a new position after a real move.
const MIN_MOVE_M = 40;

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.hypot(x, y) * 6_371_000;
}

function parseAt(at: string | null): Located | null {
  const [lat, lng] = (at ?? "").split(",").map(Number);
  if (!at || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, source: "override", note: "Location set by ?at=" };
}

// Facts about the browser that don't change while the page is open. Read through
// useSyncExternalStore so the server render and hydration agree (server: no override).
const noSubscribe = () => () => {};
const readAt = () => new URLSearchParams(window.location.search).get("at");
const readHasGeo = () => "geolocation" in navigator;

// Where the user is: ?at=lat,lng for testing, else the browser's GPS, else the demo spot.
export function useLocation(): Located | null {
  const at = useSyncExternalStore(noSubscribe, readAt, () => null);
  const hasGeo = useSyncExternalStore(noSubscribe, readHasGeo, () => true);
  const forced = useMemo(() => parseAt(at), [at]);
  const [gps, setGps] = useState<Located | null>(null);

  useEffect(() => {
    if (forced || !hasGeo) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const next = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setGps((prev) =>
          prev?.source === "gps" && metersBetween(prev, next) < MIN_MOVE_M ? prev : { ...next, source: "gps" },
        );
      },
      (err) =>
        setGps((prev) =>
          prev ?? {
            ...DEMO,
            source: "demo",
            note:
              err.code === err.PERMISSION_DENIED
                ? "Location is off. Showing Washington Square."
                : "Couldn't get a GPS fix. Showing Washington Square.",
          },
        ),
      { enableHighAccuracy: false, maximumAge: 30_000, timeout: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [forced, hasGeo]);

  if (forced) return forced;
  if (!hasGeo) return NO_GPS;
  return gps;
}
