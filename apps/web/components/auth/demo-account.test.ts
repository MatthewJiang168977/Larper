import { describe, expect, it } from "vitest";
import { demoEnabled, signInAppearance } from "./demo-account";
import { larperOsAuthAppearance } from "./clerk-appearance";

describe("demoEnabled", () => {
  it("is on only when sign-ups are restricted", () => {
    expect(demoEnabled("restricted")).toBe(true);
    expect(demoEnabled("public")).toBe(false);
    expect(demoEnabled(undefined)).toBe(false);
  });
});

describe("signInAppearance", () => {
  it("hides the sign-up link only when sign-ups are restricted, and never has a subtitle", () => {
    expect(signInAppearance("restricted").elements).toMatchObject({
      footerAction: { display: "none" },
      headerSubtitle: { display: "none" },
    });
    for (const mode of ["public", undefined]) {
      expect(signInAppearance(mode).elements).not.toHaveProperty("footerAction");
      expect(signInAppearance(mode).elements.headerSubtitle).toEqual({ display: "none" });
    }
    expect(larperOsAuthAppearance.elements).not.toHaveProperty("footerAction");
  });
});
