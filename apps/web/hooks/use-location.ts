"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

/** Why we're showing the demo spot instead of the user. */
export type DemoReason = "waiting" | "denied" | "unavailable" | "no-gps";

export interface Located {
  lat: number;
  lng: number;
  source: "gps" | "override" | "demo";
  /** GPS accuracy radius in meters, when the browser reports one. */
  accuracyM?: number;
  note?: string;
  /** Set when source is "demo". */
  reason?: DemoReason;
}

export interface LocationState {
  loc: Located | null;
  /** Ask the browser again (after a denial it won't prompt: the user has to allow it in settings). */
  retry: () => void;
  /** A retry is in progress and hasn't been answered yet. */
  retrying: boolean;
}

// Washington Square Park: the demo spot when GPS is unavailable or denied.
const DEMO = { lat: 40.7308, lng: -73.9973 };
const DEMO_NOTES: Record<DemoReason, string> = {
  waiting: "Still waiting for your location. Showing Washington Square.",
  denied: "Location is off. Showing Washington Square.",
  unavailable: "Couldn't get a GPS fix. Showing Washington Square.",
  "no-gps": "No GPS on this device. Showing Washington Square.",
};
const demo = (reason: DemoReason): Located => ({ ...DEMO, source: "demo", reason, note: DEMO_NOTES[reason] });
// Module-level so it's the same object every render (callers use it as an effect dep).
const NO_GPS = demo("no-gps");
// Ignore GPS jitter; only report a new position after a real move.
const MIN_MOVE_M = 40;
// The browser's own `timeout` only starts once the permission prompt is answered, so a
// prompt the user ignores would leave "Finding you…" up forever. After this long without
// a fix, show the demo spot; a real fix still replaces it whenever it arrives.
export const LOCATE_TIMEOUT_MS = 12_000;

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
export function useLocation(): LocationState {
  const at = useSyncExternalStore(noSubscribe, readAt, () => null);
  const hasGeo = useSyncExternalStore(noSubscribe, readHasGeo, () => true);
  const forced = useMemo(() => parseAt(at), [at]);
  const [gps, setGps] = useState<Located | null>(null);
  // Each retry restarts the watch; `answered` is the last attempt the browser (or the
  // fallback timer) has answered.
  const [attempt, setAttempt] = useState(0);
  const [answered, setAnswered] = useState(0);

  useEffect(() => {
    if (forced || !hasGeo) return;
    const fallback = setTimeout(() => {
      setGps((prev) => prev ?? demo("waiting"));
      setAnswered(attempt);
    }, LOCATE_TIMEOUT_MS);
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const next = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy };
        setGps((prev) =>
          prev?.source === "gps" && metersBetween(prev, next) < MIN_MOVE_M ? prev : { ...next, source: "gps" },
        );
        setAnswered(attempt);
      },
      // Keep a real fix through a later error; otherwise say why we're on the demo spot.
      // Same reason, same object: the watch can report errors repeatedly, and a new
      // object would refetch the deck each time.
      (err) => {
        const reason: DemoReason = err.code === err.PERMISSION_DENIED ? "denied" : "unavailable";
        setGps((prev) => (prev?.source === "gps" || prev?.reason === reason ? prev : demo(reason)));
        setAnswered(attempt);
      },
      { enableHighAccuracy: false, maximumAge: 30_000, timeout: 10_000 },
    );
    return () => {
      clearTimeout(fallback);
      navigator.geolocation.clearWatch(id);
    };
  }, [forced, hasGeo, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const loc = forced ?? (hasGeo ? gps : NO_GPS);
  return { loc, retry, retrying: attempt > answered };
}
