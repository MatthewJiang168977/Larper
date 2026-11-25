import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clockParts } from "./auth-menu-bar";
import { larperOsAuthAppearance } from "./clerk-appearance";
import { larperOsLocalization } from "./clerk-localization";
import { WALLPAPER_MAX_BYTES, WALLPAPER_PHASES, WALLPAPER_SIZES, wallpaperUrl } from "./wallpaper-stills";

const web = join(__dirname, "../..");
const css = readFileSync(join(__dirname, "larper-os-auth.css"), "utf8");

describe("wallpaper stills", () => {
  const files = WALLPAPER_PHASES.flatMap((phase) =>
    (["phone", "desktop"] as const).map((size) => ({ url: wallpaperUrl(phase, size), ...WALLPAPER_SIZES[size] })));

  it.each(files)("$url is a WebP of the right size within budget", ({ url, width, height }) => {
    const path = join(web, "public", url);
    expect(statSync(path).size).toBeLessThanOrEqual(WALLPAPER_MAX_BYTES);
    const b = readFileSync(path);
    expect(b.toString("ascii", 8, 12)).toBe("WEBP");
    // Lossy WebP keeps its size in the VP8 frame header; extended files in VP8X.
    const size = b.toString("ascii", 12, 16) === "VP8X"
      ? [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1]
      : [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    expect(size).toEqual([width, height]);
  });
});

describe("the demo's two places", () => {
  it("shows under the form below 1024px, and beside the window from there up", () => {
    const [narrow, wide] = css.split("@media (min-width: 1024px)");
    expect(narrow).toMatch(/\.larper-auth-demo-window \{ display: none; \}/);
    expect(narrow).not.toMatch(/\.larper-os-auth-demo \{ display: none/);
    expect(wide).toMatch(/\.larper-auth-form > \.larper-os-auth-demo \{ display: none; \}/);
    expect(wide).toMatch(/grid-template-columns: minmax\(0, 760px\) 300px/);
  });
});

describe("Clerk, themed only", () => {
  it("says what the design says", () => {
    expect(larperOsLocalization.socialButtonsBlockButton).toBe("continue with {{provider|titleize}}");
    expect(larperOsLocalization.signUp?.start).toMatchObject({
      title: "welcome in.",
      subtitle: "one quest a day, picked for you.",
    });
    expect(JSON.stringify(larperOsLocalization)).not.toMatch(/invited/);
  });

  it("keeps links and controls at least 44px tall", () => {
    const e = larperOsAuthAppearance.elements;
    for (const key of ["footerActionLink", "formFieldAction", "formResendCodeLink", "identityPreviewEditButton",
      "backLink", "headerBackLink", "formFieldInputShowPasswordButton", "formButtonPrimary",
      "socialButtonsBlockButton", "formFieldInput"] as const) {
      expect(e[key].minHeight, key).toBe("var(--larper-os-tap-min)");
    }
  });
});

describe("menu bar clock", () => {
  it("is lowercase, with the day for wide screens", () => {
    expect(clockParts(new Date(2026, 10, 25, 12, 40))).toEqual({ date: "wed 25 nov", time: "12:40 pm" });
  });
});
