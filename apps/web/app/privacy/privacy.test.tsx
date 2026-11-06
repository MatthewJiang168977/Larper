import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PrivacyPage from "./page";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe("Privacy", () => {
  it("names the three services, each with what it collects", () => {
    render(<PrivacyPage />);
    for (const name of ["Vercel Web Analytics", "PostHog", "Sentry"]) {
      const section = screen.getByRole("region", { name });
      expect(section.querySelectorAll("li").length).toBeGreaterThan(0);
    }
  });

  it("says no coordinates or place names go to any of them", () => {
    render(<PrivacyPage />);
    expect(screen.getByRole("main").textContent).toMatch(/none of the services below get your\s+coordinates/);
  });
});
