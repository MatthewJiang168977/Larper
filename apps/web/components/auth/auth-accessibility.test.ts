import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(join(__dirname, name), "utf8");
const tokens = readFileSync(join(__dirname, "../../app/larper-os.css"), "utf8");
const sheets = ["larper-os-auth.css", "larper-os-account-window.css"].map(read);

const token = (name: string) => tokens.match(new RegExp(`--larper-os-${name}:\\s*(#[0-9a-f]{6})`, "i"))![1];
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// The windows look the same by day and by night: only the wallpaper changes, and every line of
// text sits on one of these opaque fills, never on the map itself.
describe("text contrast on the sign-in and account windows", () => {
  it.each([
    ["ink", "window"], ["ink", "paper"], ["ink", "pink"], ["ink", "butter"], ["ink", "pool"], ["ink", "pool-hover"],
    ["disabled-ink", "window"], ["disabled-ink", "disabled"], ["red", "window"], ["red", "paper"], ["window", "ink"],
  ])("%s on %s is at least 4.5:1", (text, fill) => {
    expect(contrast(token(text), token(fill))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("reduced motion", () => {
  it("switches off Clerk's motion, and Larper's own sheets add none", () => {
    for (const css of sheets) {
      const [outside, reduced] = css.split("@media (prefers-reduced-motion: reduce)");
      expect(reduced).toMatch(/transition: none !important; ?/);
      expect(reduced).toMatch(/animation: none !important;/);
      expect(outside).not.toMatch(/^\s*(animation|transition)(-[a-z]+)?:/m);
    }
  });
});
