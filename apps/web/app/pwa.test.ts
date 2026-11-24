import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "./manifest";

const root = join(__dirname, "..");
const css = readFileSync(join(__dirname, "larper-os.css"), "utf8");
const transitions = readFileSync(join(__dirname, "larper-transitions.css"), "utf8");
const layout = readFileSync(join(__dirname, "layout.tsx"), "utf8");

describe("PWA", () => {
  it("has a full icon set, including a maskable one, and every file exists", () => {
    const icons = manifest().icons ?? [];
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
    expect(icons.some((i) => i.sizes === "192x192")).toBe(true);
    expect(icons.some((i) => i.sizes === "512x512")).toBe(true);
    for (const i of icons) expect(existsSync(join(root, "public", i.src)), i.src).toBe(true);
    expect(existsSync(join(root, "public/apple-touch-icon.png"))).toBe(true);
    expect(existsSync(join(__dirname, "favicon.ico"))).toBe(true);
  });

  it("uses the menu bar colour as the theme colour in the manifest and the page", () => {
    const window = css.match(/--larper-os-window:\s*(#[0-9a-f]{6})/i)![1].toLowerCase();
    expect(manifest().theme_color?.toLowerCase()).toBe(window);
    expect(layout.toLowerCase()).toContain(`themecolor: "${window}"`);
  });
});

describe("motion", () => {
  it("is under 200ms and switched off for reduced motion", () => {
    for (const [, ms] of transitions.matchAll(/(\d+)ms/g)) expect(Number(ms)).toBeLessThanOrEqual(200);
    const reduced = transitions.slice(transitions.indexOf("prefers-reduced-motion"));
    expect(reduced).toMatch(/view-transition-new\(\*\)/);
    expect(reduced).toMatch(/animation: none/);
  });
});
