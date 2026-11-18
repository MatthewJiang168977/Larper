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
    for (const item of [
      "Clerk ID",
      "taste profile",
      "quest journal with places",
      "check-ins and check-in attempts",
      "was it open",
      "saved places",
      "For open or accepted quests",
      "your precise location at the time of the offer",
      "distance and location accuracy",
    ]) expect(t).toContain(item);
    expect(t).toContain("bottom of the journal");
    expect(t).not.toMatch(/everything Larper holds|events/);
  });

  it("says what each delete removes and keeps", () => {
    render(<PrivacyPage />);
    const h = section("Delete my history");
    expect(h).toMatch(/Removes your journal/);
    expect(h).toMatch(/Keeps your account, your sign-in and your taste profile/);
    const a = section("Delete my account");
    expect(a).toMatch(/your taste profile and your Larper account/);
    expect(a).toMatch(/Also deletes your sign-in, then signs you out/);
    expect(a).toMatch(/you stay signed in to try again/);
    expect(a).toMatch(/sign up again later, with the same email if you like\. That makes a new, empty account/);
    expect(a).toMatch(/Nothing is kept to recognise you/);
    expect(a).not.toMatch(/automatic|manual|by hand|you're signed out/i);
  });

  it("describes the backup schedule, object cleanup rule and restore caveat", () => {
    render(<PrivacyPage />);
    const b = section("Backups");
    expect(b).toMatch(/about 3 weeks under the usual backup schedule/);
    expect(b).toMatch(/60-day cleanup rule for old objects/);
    expect(b).not.toMatch(/at (the very )?most|within 60 days/);
    expect(b).toMatch(/Restoring a backup could bring back data deleted/);
    expect(b).toMatch(/demo account can't be exported or deleted/);
  });

  it("describes broker retention as segment eligibility with no fixed deadline", () => {
    render(<PrivacyPage />);
    const events = section("Events already sent");
    expect(events).toMatch(/can remain after deletion/);
    expect(events).toMatch(/until its scheduled cleanup/);
    expect(events).toMatch(/no fixed deletion deadline/);
  });

  it("never says 7 days, by hand, manual or removal within a number of days, anywhere on the page", () => {
    render(<PrivacyPage />);
    const all = screen.getByRole("main").textContent ?? "";
    expect(all).not.toMatch(/7 days|seven days|by hand|manual|within \d+ days/i);
  });
});
