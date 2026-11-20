import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  avatarInitials, avatarInitialsAppearance, CLERK_APPEARANCE, larperOsAuthAppearance, userProfileAppearance,
} from "./clerk-appearance";

const css = readFileSync(join(__dirname, "../../app/larper-os.css"), "utf8");
const json = JSON.stringify(CLERK_APPEARANCE);

describe("CLERK_APPEARANCE", () => {
  it("uses Larper OS colour tokens and each one exists", () => {
    const colours = Object.entries(CLERK_APPEARANCE.variables).filter(([k]) => k.startsWith("color"));
    for (const [, value] of colours) expect(value).toMatch(/^var\(--larper-os-[a-z-]+\)$/);
    for (const [, name] of json.matchAll(/var\(--([a-z-]+)\)/g)) {
      if (name.startsWith("font-") || name.startsWith("larper-os-font-")) continue; // Set by next/font.
      expect(css, `--${name}`).toMatch(new RegExp(`--${name}:`));
    }
  });

  it("has no literal colours: no hex, rgb, violet or gradient", () => {
    expect(json).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|violet|purple|gradient\(/i);
  });

  it("uses ink for text and primary buttons, and the OS red for links", () => {
    const v = CLERK_APPEARANCE.variables;
    expect(v.colorBackground).toBe("var(--larper-os-window)");
    expect(v.colorForeground).toBe("var(--larper-os-ink)");
    expect(v.colorMutedForeground).toBe("var(--larper-os-disabled-ink)");
    expect(v.colorInputForeground).toBe("var(--larper-os-ink)");
    expect(v.colorPrimaryForeground).toBe("var(--larper-os-ink)");
    expect(CLERK_APPEARANCE.elements.footerActionLink.color).toBe("var(--larper-os-red)");
    expect(CLERK_APPEARANCE.elements.formFieldAction.color).toBe("var(--larper-os-red)");
    expect(json).not.toMatch(/var\(--(?:paper|paper-deep|ink-soft|ink-faint|ink|oxblood)\)/);
  });

  it("uses the OS body and pixel fonts, and JetBrains Mono for codes", () => {
    expect(CLERK_APPEARANCE.variables.fontFamily).toMatch(/^var\(--larper-os-font-body\)/);
    expect(CLERK_APPEARANCE.elements.headerTitle.fontFamily).toMatch(/^var\(--larper-os-font-pixel\)/);
    expect(CLERK_APPEARANCE.variables.fontFamilyMono).toMatch(/^var\(--font-jetbrains\)/);
  });

  it("uses the OS button treatment and leaves motion off", () => {
    const b = CLERK_APPEARANCE.elements.formButtonPrimary;
    expect(CLERK_APPEARANCE.variables.borderRadius).toBe("var(--larper-os-radius-tag)");
    expect(b.border).toBe("1px solid var(--larper-os-ink)");
    expect(b.boxShadow).toBe("var(--larper-os-shadow-raised)");
    expect(b.backgroundImage).toBe("none");
    expect(CLERK_APPEARANCE.theme).toBe("simple");
    expect(b.transition).toBe("none");
    expect(b["&:active"].transform).toBe("none");
  });

  it("uses the OS ink focus ring and reserves outer chrome for standalone Clerk cards", () => {
    const ring = { outline: "2px solid var(--larper-os-ink)", outlineOffset: "2px" };
    expect(CLERK_APPEARANCE.elements.formButtonPrimary["&:focus-visible"]).toMatchObject(ring);
    expect(CLERK_APPEARANCE.elements.formFieldInput["&:focus, &:focus-visible"]).toMatchObject(ring);
    expect(CLERK_APPEARANCE.elements.button["&:focus-visible"]).toMatchObject(ring);
    expect(larperOsAuthAppearance.variables).toBe(CLERK_APPEARANCE.variables);
    expect(CLERK_APPEARANCE.elements.cardBox.boxShadow).toBe("var(--larper-os-shadow-window)");
    expect(larperOsAuthAppearance.elements.cardBox.boxShadow).toBe("none");
    expect(CLERK_APPEARANCE.elements.card.boxShadow).toBe("none");
  });

  it("uses the OS window colour and ink rim for the avatar", () => {
    expect(CLERK_APPEARANCE.elements.avatarBox).toMatchObject({
      backgroundColor: "var(--larper-os-window)",
      border: "1px solid var(--larper-os-ink)",
      color: "var(--larper-os-ink)",
    });
  });

  it("scopes portal and profile styling without suppressing Clerk notices", () => {
    expect(CLERK_APPEARANCE.elements.modalContent).toBe("larper-os larper-os-clerk-modal");
    expect(userProfileAppearance(null).elements.rootBox).toBe("larper-os-clerk-profile");
    expect(json).not.toMatch(/"display":"none"|developmentModeWarning|unsafe_disableDevelopmentModeWarnings/);
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
    expect(a.elements.avatarBox["&::after"]).toMatchObject({ content: '"AB"', color: "var(--larper-os-ink)" });
    expect(avatarInitialsAppearance({ ...user, hasImage: true })).toBeUndefined();
    expect(avatarInitialsAppearance(null)).toBeUndefined();
    // Nothing to draw: keep Clerk's image rather than an empty disc.
    expect(avatarInitialsAppearance({ hasImage: false, firstName: null, lastName: null })).toBeUndefined();
  });
});
