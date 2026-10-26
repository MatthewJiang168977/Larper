import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { avatarInitials, avatarInitialsAppearance, CLERK_APPEARANCE } from "./clerk-appearance";

const css = readFileSync(join(__dirname, "../../app/globals.css"), "utf8");
const json = JSON.stringify(CLERK_APPEARANCE);

describe("CLERK_APPEARANCE", () => {
  it("colours everything from the globals.css tokens, and each one exists", () => {
    const colours = Object.entries(CLERK_APPEARANCE.variables).filter(([k]) => k.startsWith("color"));
    for (const [, value] of colours) expect(value).toMatch(/^var\(--[a-z-]+\)$/);
    for (const [, name] of json.matchAll(/var\(--([a-z-]+)\)/g)) {
      if (name.startsWith("font-")) continue; // next/font's variables, set in layout.tsx
      expect(css, `--${name}`).toMatch(new RegExp(`--${name}:`));
    }
  });

  it("has no literal colours: no hex, rgb, violet or gradient", () => {
    expect(json).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|violet|purple|gradient\(/i);
  });

  it("text is ink on paper, muted text --ink-soft (AA on paper and paper-deep), links oxblood", () => {
    const v = CLERK_APPEARANCE.variables;
    expect(v.colorBackground).toBe("var(--paper)");
    expect(v.colorForeground).toBe("var(--ink)");
    expect(v.colorMutedForeground).toBe("var(--ink-soft)");
    expect(v.colorInputForeground).toBe("var(--ink)");
    expect(v.colorPrimaryForeground).toBe("var(--paper)");
    expect(CLERK_APPEARANCE.elements.footerActionLink.color).toBe("var(--oxblood)");
    expect(CLERK_APPEARANCE.elements.formFieldAction.color).toBe("var(--oxblood)");
    // --ink-faint (3.1:1) is for borders only, never text.
    expect(json).not.toMatch(/"color(Foreground|MutedForeground|InputForeground)?":"var\(--ink-faint\)"/);
  });

  it("uses the app's faces: Fraunces for text and headings, JetBrains Mono for codes", () => {
    expect(CLERK_APPEARANCE.variables.fontFamily).toMatch(/^var\(--font-fraunces\)/);
    expect(CLERK_APPEARANCE.elements.headerTitle.fontFamily).toMatch(/^var\(--font-fraunces\)/);
    expect(CLERK_APPEARANCE.variables.fontFamilyMono).toMatch(/^var\(--font-jetbrains\)/);
  });

  it("the primary button is a square .stamp-btn: ink border, hard shadow, presses down, no gradient", () => {
    const b = CLERK_APPEARANCE.elements.formButtonPrimary;
    expect(CLERK_APPEARANCE.variables.borderRadius).toBe("0");
    expect(b.border).toBe("1.5px solid var(--ink)");
    expect(b.boxShadow).toBe("2px 2px 0 var(--ink)");
    expect(b.backgroundImage).toBe("none");
    expect(b["&::after"]).toEqual({ display: "none" });
    // Clerk's plain base theme, so its layered shadows don't stack on the stamp's.
    expect(CLERK_APPEARANCE.theme).toBe("simple");
    expect(b["&:active"]).toEqual({ transform: "translate(2px, 2px)", boxShadow: "0 0 0 var(--ink)" });
  });

  it("focus is the app's oxblood ring, and the card has no shadow", () => {
    const ring = { outline: "2px solid var(--oxblood)", outlineOffset: "3px" };
    expect(CLERK_APPEARANCE.elements.formButtonPrimary["&:focus-visible"]).toMatchObject(ring);
    expect(CLERK_APPEARANCE.elements.formFieldInput["&:focus, &:focus-visible"]).toMatchObject(ring);
    expect(CLERK_APPEARANCE.elements.button["&:focus-visible"]).toMatchObject(ring);
    expect(CLERK_APPEARANCE.elements.cardBox.boxShadow).toBe("none");
    expect(CLERK_APPEARANCE.elements.card.boxShadow).toBe("none");
  });

  it("the avatar is a paper-deep disc with an ink rim", () => {
    expect(CLERK_APPEARANCE.elements.avatarBox).toMatchObject({
      backgroundColor: "var(--paper-deep)",
      border: "1px solid var(--ink)",
      color: "var(--ink)",
    });
  });
});

describe("avatar initials", () => {
  const user = { hasImage: false, firstName: "ada", lastName: "Byron" };

  it("takes the first letters of the names, then the username or email", () => {
    expect(avatarInitials(user)).toBe("AB");
    expect(avatarInitials({ ...user, lastName: null })).toBe("A");
    expect(avatarInitials({ hasImage: false, firstName: null, lastName: " ", username: "larper" })).toBe("L");
    const email = { hasImage: false, firstName: null, lastName: null, primaryEmailAddress: { emailAddress: "zed@x.io" } };
    expect(avatarInitials(email)).toBe("Z");
  });

  it("swaps Clerk's generated image for ink initials only when there's no uploaded photo", () => {
    const a = avatarInitialsAppearance(user)!;
    expect(a.elements.avatarImage).toEqual({ display: "none" });
    expect(a.elements.avatarBox["&::after"]).toMatchObject({ content: '"AB"', color: "var(--ink)" });
    expect(avatarInitialsAppearance({ ...user, hasImage: true })).toBeUndefined();
    expect(avatarInitialsAppearance(null)).toBeUndefined();
    // Nothing to draw: keep Clerk's image rather than an empty disc.
    expect(avatarInitialsAppearance({ hasImage: false, firstName: null, lastName: null })).toBeUndefined();
  });
});
