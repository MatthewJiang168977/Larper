"use client";

import dynamic from "next/dynamic";

// Dev only: a page file ending in .dev.tsx is a route only under `next dev`
// (pageExtensions in next.config.ts), so production builds have no /dev/map-style.
const MapStylePlayground = dynamic(() => import("@/components/map/dev/map-style-playground"), { ssr: false });

export default function MapStylePage() {
  return <MapStylePlayground />;
}
