// Draws the PWA icon set into public/ with next/og (run: node scripts/make-icons.mjs).
// The PNGs are committed, so a build needs nothing from this script.
import { writeFile } from "node:fs/promises";
import { createElement } from "react";
import { ImageResponse } from "next/og.js";
import { IconCard } from "../lib/og-card.tsx";

const icons = [
  ["icon-192.png", 192, 0],
  ["icon-512.png", 512, 0],
  // Maskable: the window sits inside the central 80% safe zone; the pink fills the rest.
  ["icon-maskable-512.png", 512, 56],
  ["apple-touch-icon.png", 180, 0],
];
for (const [name, size, inset] of icons) {
  const res = new ImageResponse(createElement(IconCard, { size, inset }), { width: size, height: size });
  await writeFile(new URL(`../public/${name}`, import.meta.url), Buffer.from(await res.arrayBuffer()));
  console.log("wrote", name);
}
