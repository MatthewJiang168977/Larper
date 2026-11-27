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

const osCss = readFileSync(join(web, "app/larper-os.css"), "utf8");

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
const token = (name: string) => {
  const m = osCss.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
  if (!m) throw new Error(`missing token --${name}`);
  return m[1];
};

describe("the window's tint for the time of day", () => {
  it.each(WALLPAPER_PHASES)("%s: ink, links and muted text hold 4.5:1 on its tint", (phase) => {
    const tint = token(`larper-os-tint-${phase}`);
    for (const ink of ["larper-os-ink", "larper-os-red", "larper-os-disabled-ink"]) {
      expect(contrast(token(ink), tint), ink).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("is a light tint everywhere, night included", () => {
    for (const phase of WALLPAPER_PHASES) expect(luminance(token(`larper-os-tint-${phase}`)), phase).toBeGreaterThan(0.7);
  });

  it("starts as the day's tint, then follows data-phase", () => {
    expect(css).toMatch(/\.larper-os-auth \{\s*--larper-auth-tint: var\(--larper-os-tint-day\);/);
    for (const phase of ["dawn", "golden", "dusk", "night"]) {
      expect(css).toContain(`.larper-os-auth[data-phase="${phase}"] { --larper-auth-tint: var(--larper-os-tint-${phase}); }`);
    }
    expect(css).toMatch(/\.larper-os-auth \.larper-os-window \{ background: var\(--larper-auth-tint\); \}/);
  });
});

describe("one column, with nothing made up", () => {
  it("has no side pane, pins, flag, band, teaser or second window in the stylesheet", () => {
    expect(css).not.toMatch(/minimap|larper-auth-pin|larper-auth-flag|larper-auth-band|teaser|redacted|demo-window|larper-auth-split|larper-auth-pane|usericon/);
  });
});

describe("Clerk, themed only", () => {
  it("says what the design says", () => {
    expect(larperOsLocalization.socialButtonsBlockButton).toBe("continue with {{provider|titleize}}");
    expect(larperOsLocalization.signUp?.start).toMatchObject({
      title: "create your account",
      subtitle: "welcome in.",
    });
    expect(JSON.stringify(larperOsLocalization)).not.toMatch(/invited/);
  });

  it("writes each error as plain sentences, in the words the form uses", () => {
    const errors = Object.entries(larperOsLocalization.unstable__errors ?? {});
    expect(errors.map(([code]) => code)).toEqual(expect.arrayContaining([
      "form_identifier_not_found", "form_password_incorrect", "form_code_incorrect",
      "form_identifier_exists__email_address", "not_allowed_access", "oauth_access_denied", "session_exists",
    ]));
    for (const [code, text] of errors) expect(text, code).toMatch(/^[A-Z].*\.$/);
    // The button says "continue with Google" and the field "email address": errors don't invent others.
    expect(JSON.stringify(errors)).not.toMatch(/invit|log ?in\b/i);
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
