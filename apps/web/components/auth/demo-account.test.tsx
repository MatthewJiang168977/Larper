import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DemoAccount, signInAppearance } from "./demo-account";

describe("DemoAccount", () => {
  it("shows the shared account's email and password", () => {
    render(<DemoAccount email="demo@playlarper.com" password="correct-horse-battery" />);
    const box = screen.getByRole("region", { name: "Demo account" });
    expect(box.textContent).toContain("demo@playlarper.com");
    expect(box.textContent).toContain("correct-horse-battery");
  });

  it("shows nothing unless both are configured", () => {
    const { container, rerender } = render(<DemoAccount />);
    expect(container.textContent).toBe("");
    rerender(<DemoAccount email="demo@playlarper.com" />);
    expect(container.textContent).toBe("");
  });
});

describe("signInAppearance", () => {
  it("hides the sign-up link only when sign-ups are restricted", () => {
    expect(signInAppearance("restricted")).toEqual({ elements: { footerAction: { display: "none" } } });
    expect(signInAppearance("public")).toBeUndefined();
    expect(signInAppearance(undefined)).toBeUndefined();
  });
});
