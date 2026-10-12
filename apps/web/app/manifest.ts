import type { MetadataRoute } from "next";

// Makes the app installable to a phone home screen (PWA).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Larper",
    short_name: "Larper",
    description: "The most niche thing to do near you.",
    start_url: "/",
    display: "standalone",
    background_color: "#f2ead8",
    theme_color: "#f2ead8",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
