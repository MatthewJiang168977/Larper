"use client";

export interface Fix {
  lat: number;
  lng: number;
  /** The browser's accuracy radius in meters. */
  accuracyM: number;
}

// How long "I went" waits for a precise reading before checking in with the best so far.
export const PRECISE_FIX_MAX_MS = 8_000;
// Good enough to stop early: well inside the 75 m check-in radius.
export const GOOD_ENOUGH_M = 20;

// One fresh, high-accuracy reading for a check-in. The map's position comes from a
// low-power watch that may reuse a reading up to 30 s old and only updates after a
// 40 m move, so at the door it can still be a rough fix from down the block.
//
// Watches with enableHighAccuracy and no cached readings, keeps the most accurate fix,
// and resolves as soon as one is within GOOD_ENOUGH_M or after maxMs with the best it
// got. Resolves null when there's no reading at all (denied, unavailable, no GPS).
export function getPreciseFix(maxMs = PRECISE_FIX_MAX_MS): Promise<Fix | null> {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let best: Fix | null = null;
    let done = false;
    // The watch id, once watchPosition has returned (an answer can arrive before that).
    const watch: { id?: number } = {};
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (watch.id !== undefined) navigator.geolocation.clearWatch(watch.id);
      resolve(best);
    };
    const timer = setTimeout(finish, maxMs);
    watch.id = navigator.geolocation.watchPosition(
      (pos) => {
        const fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy };
        if (!best || fix.accuracyM < best.accuracyM) best = fix;
        if (best.accuracyM <= GOOD_ENOUGH_M) finish();
      },
      // Denied won't change within the wait; other errors (a timeout, no signal yet)
      // might, so keep watching until the deadline.
      (err) => {
        if (err.code === err.PERMISSION_DENIED) finish();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: maxMs },
    );
    if (done) navigator.geolocation.clearWatch(watch.id); // answered synchronously
  });
}
