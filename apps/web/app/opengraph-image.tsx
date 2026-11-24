import { ImageResponse } from "next/og";
import { OgCard } from "@/lib/og-card";

export const alt = "larper: one niche quest a day, picked for you.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Static: drawn at build time, with no place, address or time in it.
export default function OpenGraphImage() {
  return new ImageResponse(<OgCard />, size);
}
