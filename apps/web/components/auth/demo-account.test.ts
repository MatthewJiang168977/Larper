import { describe, expect, it } from "vitest";
import { demoEnabled, signInAppearance } from "./demo-account";

describe("demoEnabled", () => {
  it("is on only when sign-ups are restricted", () => {
    expect(demoEnabled("restricted")).toBe(true);
    expect(demoEnabled("public")).toBe(false);
    expect(demoEnabled(undefined)).toBe(false);
  });
});

describe("signInAppearance", () => {
  it("hides the sign-up link only when sign-ups are restricted", () => {
    expect(signInAppearance("restricted")).toEqual({ elements: { footerAction: { display: "none" } } });
    expect(signInAppearance("public")).toBeUndefined();
    expect(signInAppearance(undefined)).toBeUndefined();
  });
});
