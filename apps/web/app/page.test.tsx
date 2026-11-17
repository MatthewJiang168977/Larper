import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import Home from "./page";

vi.mock("@clerk/nextjs", () => ({
  Show: ({ when, children }: { when: string; children: ReactNode }) => when === "signed-out" ? children : null,
  SignInButton: ({ children }: { children: ReactNode }) => children,
  SignUpButton: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/app/larper-os", () => ({ larperOsClassName: "larper-os" }));
vi.mock("@/components/auth/try-demo", () => ({
  TryDemoButton: ({ className }: { className: string }) => <button className={className}>Try the demo</button>,
}));
vi.mock("@/components/quest/quest-home", () => ({ QuestHome: () => null }));
vi.mock("@/components/track-landing", () => ({ TrackLanding: () => <span data-testid="track-landing" /> }));

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["restricted", "Try the demo", "start a quest log"],
  [undefined, "start a quest log", "Try the demo"],
])("offers the right entry action in %s signup mode", (mode, primary, excluded) => {
  vi.stubEnv("NEXT_PUBLIC_SIGNUP_MODE", mode);
  render(<Home />);
  expect(screen.getByRole("button", { name: primary })).toBeTruthy();
  expect(screen.queryByRole("button", { name: excluded })).toBeNull();
  expect(screen.getByRole("button", { name: "sign in" })).toBeTruthy();
  expect(screen.getByTestId("track-landing")).toBeTruthy();
  expect(screen.getByRole("link", { name: "privacy" }).getAttribute("href")).toBe("/privacy");
});
