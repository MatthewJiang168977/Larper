"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef } from "react";
import { clearDemo } from "@/lib/analytics";

/**
 * Forgets the demo flag when someone signs out or switches accounts. Clerk can do either
 * without a page load, and the flag lives in memory (lib/analytics.ts). A sign-in from
 * signed-out clears nothing: "Try the demo" has already set the flag by then.
 * Renders nothing.
 */
export function AnalyticsAuth() {
  const { isLoaded, userId } = useAuth();
  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    const current = userId ?? null;
    if (previous.current && previous.current !== current) clearDemo();
    previous.current = current;
  }, [isLoaded, userId]);

  return null;
}
