"use client";

import { useSyncExternalStore } from "react";

// Whether a media query matches, kept up to date. False on the server and where
// matchMedia is missing (jsdom), so the phone layout is the default.
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** Desktop gets a side panel instead of the bottom sheet (Tailwind's lg). */
export const DESKTOP_QUERY = "(min-width: 1024px)";
