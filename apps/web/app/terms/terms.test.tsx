import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TermsPage from "./page";

vi.mock("@/app/larper-os", () => ({ larperOsClassName: "larper-os" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe("Terms", () => {
  it("shows one Terms heading in the OS shell, with a way back", () => {
    render(<TermsPage />);
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings.map((h) => h.textContent)).toEqual(["Terms"]);
    expect(screen.getByRole("region", { name: "Terms" }).contains(headings[0])).toBe(true);
    expect(screen.getByRole("link", { name: "← Larper" }).getAttribute("href")).toBe("/");
  });

  it("says when it last changed", () => {
    render(<TermsPage />);
    expect(screen.getByRole("main").textContent).toMatch(/Last changed \d{1,2} \w+ \d{4}\./);
  });

  it("covers wrong places, safety, accounts, data and warranties, each with points", () => {
    render(<TermsPage />);
    for (const name of [
      "What Larper is",
      "Places can be wrong",
      "Getting there is up to you",
      "Your account",
      "Your data",
      "No guarantees",
      "Changes",
    ]) {
      expect(screen.getByRole("region", { name }).querySelectorAll("li").length).toBeGreaterThan(0);
    }
    expect(screen.getByRole("region", { name: "Places can be wrong" }).textContent).toMatch(/may be closed/);
    expect(screen.getByRole("region", { name: "Your account" }).textContent).toMatch(/reset every night/);
  });

  it("links to privacy and credits", () => {
    render(<TermsPage />);
    expect(screen.getByRole("link", { name: "privacy" }).getAttribute("href")).toBe("/privacy");
    expect(screen.getByRole("link", { name: "credits" }).getAttribute("href")).toBe("/credits");
  });
});
