"use client";

import { useEffect } from "react";
import { track } from "@/lib/analytics";

/** Records that a page was seen, once per mount (lib/analytics.ts). Renders nothing. */
export function TrackView({ event }: { event: "landing_viewed" | "journal_opened" }) {
  useEffect(() => {
    track(event);
  }, [event]);
  return null;
}
