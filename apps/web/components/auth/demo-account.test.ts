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
  it("hides the sign-up link only when sign-ups are restricted", () => {
    expect(signInAppearance("restricted")).toEqual({
      ...larperOsAuthAppearance,
      elements: { ...larperOsAuthAppearance.elements, footerAction: { display: "none" } },
    });
    expect(signInAppearance("public")).toBe(larperOsAuthAppearance);
    expect(signInAppearance(undefined)).toBe(larperOsAuthAppearance);
    expect(larperOsAuthAppearance.elements).not.toHaveProperty("footerAction");
  });
});
