import type { MetadataRoute } from "next";

// Makes the app installable to a phone home screen (PWA).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Larper",
    short_name: "Larper",
    description: "The most niche thing to do near you.",
    start_url: "/",
    display: "standalone",
    background_color: "#f6d5d5",
    theme_color: "#f9efe4", // the menu bar (--larper-os-window)
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
