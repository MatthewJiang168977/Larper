import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The design rules that live in CSS, checked against the stylesheet itself: jsdom
// doesn't lay out or apply :focus-visible, so these read globals.css as text.
const WEB = join(__dirname, "..");
const css = readFileSync(join(WEB, "app/globals.css"), "utf8");
const osCss = readFileSync(join(WEB, "app/larper-os.css"), "utf8");

const token = (name: string, stylesheet = css) => {
  const m = stylesheet.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
  if (!m) throw new Error(`missing token --${name}`);
  return m[1];
};
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(at, css.indexOf("}", at));
};

// WCAG 2.x relative luminance and contrast ratio.
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

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (["node_modules", ".next", "public"].includes(e.name)) return [];
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(tsx?|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("text contrast", () => {
  it("--ink-label passes AA for small text on paper", () => {
    expect(token("ink-label")).toBe("#6b6455");
    expect(contrast(token("ink-label"), token("paper"))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps OS chip text, links and the compass needle legible on their opaque OS surface", () => {
    const surface = token("larper-os-window", osCss);
    for (const name of ["larper-os-ink", "larper-os-red", "larper-os-disabled-ink"]) {
      expect(contrast(token(name, osCss), surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("field labels are drawn in --ink-label", () => {
    expect(rule(".field-label")).toContain("color: var(--ink-label)");
  });

  it("does not use any of the removed Scrapbook tokens or utility aliases", () => {
    const offenders = sources(WEB).flatMap((f) => {
      const text = readFileSync(f, "utf8");
      const hits = [...text.matchAll(/--(?:color-)?(?:paper-deep|ink-faint|oxblood-soft|water)(?![-\w])|(?<![-\w])(?:font-serif|\w+-(?:paper-deep|ink-faint|oxblood-soft|water))(?![-\w])/g)];
      return hits.map(() => f.slice(WEB.length + 1));
    });
    expect(offenders).toEqual([]);
  });
});

describe("focus and touch targets", () => {
  it("every interactive element gets the oxblood focus ring, not just .stamp-btn", () => {
    const focus = rule(':where(a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])):focus-visible');
    expect(focus).toContain("outline: 2px solid var(--oxblood)");
    expect(focus).toContain("outline-offset: 3px");
    expect(css).not.toContain(".stamp-btn:focus-visible");
  });

  it(".hit-target grows the hit area to at least 44×44 without resizing the control", () => {
    expect(rule(".hit-target")).toContain("position: relative");
    const before = rule(".hit-target::before");
    expect(before).toContain("width: max(100%, 44px)");
    expect(before).toContain("height: max(100%, 44px)");
    expect(before).toContain("transform: translate(-50%, -50%)");
  });

});

describe("map credit", () => {
  it("is set at 11 px, not 10", () => {
    expect(rule(".maplibregl-ctrl-attrib")).toContain("font-size: 11px");
  });
});

describe("map markers", () => {
  it("the you-are-here dot is 22 px with a 3.5 px cream ring", () => {
    const dot = rule(".pin-me");
    expect(dot).toContain("width: 22px");
    expect(dot).toContain("height: 22px");
    expect(dot).toContain("box-shadow: inset 0 0 0 3.5px var(--paper)");
  });
});
