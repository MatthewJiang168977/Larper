"use client";

import { useEffect } from "react";
import { setDemo, track } from "@/lib/analytics";

/**
 * Records the landing page being seen, once per mount (lib/analytics.ts). Only signed-out
 * visitors see it, so they aren't on the demo account, whatever this tab was doing before.
 * Renders nothing.
 */
export function TrackLanding() {
  useEffect(() => {
    setDemo(false);
    track("landing_viewed");
  }, []);
  return null;
}
