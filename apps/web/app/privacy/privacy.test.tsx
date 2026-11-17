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

  it("says what happens to the answer to 'was it open?'", () => {
    render(<PrivacyPage />);
    const section = screen.getByRole("region", { name: "PostHog" });
    expect(section.textContent).toMatch(/yes, no or didn't check/);
    expect(section.textContent).toMatch(/keeps that answer with the place/);
    expect(section.textContent).toMatch(/PostHog only gets the answer/);
  });
});

describe("Privacy: your data", () => {
  const section = (name: string) => screen.getByRole("region", { name }).textContent ?? "";

  it("says what the export contains, and where to find it", () => {
    render(<PrivacyPage />);
    const t = section("Download my data");
    for (const word of ["taste profile", "check-ins", "was it open", "saved places", "distances only"]) expect(t).toContain(word);
    expect(t).toContain("bottom of the journal");
  });

  it("says what each delete removes and keeps", () => {
    render(<PrivacyPage />);
    const h = section("Delete my history");
    expect(h).toMatch(/Removes your journal/);
    expect(h).toMatch(/Keeps your account, your sign-in and your taste profile/);
    const a = section("Delete my account");
    expect(a).toMatch(/your taste profile and your Larper account/);
    expect(a).toMatch(/Clerk/);
    expect(a).toMatch(/by hand within 7 days/);
  });

  it("says backups keep deleted data for about 3 weeks (60 days at most) and a restore could bring it back", () => {
    render(<PrivacyPage />);
    const b = section("Backups");
    expect(b).toMatch(/about 3 weeks \(60 days at the very most\)/);
    expect(b).not.toContain("14 days");
    expect(b).toMatch(/would come back/);
    expect(b).toMatch(/demo account can't be exported or deleted/);
  });
});
