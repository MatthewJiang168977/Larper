import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import Home from "./page";

let authState = "signed-out";
let authPending: Promise<void> | null = null;
const questHome = vi.fn(() => <p>quest card</p>);
vi.mock("@clerk/nextjs", () => ({
  Show: ({ when, children }: { when: string; children: ReactNode }) => {
    if (authPending) throw authPending;
    return when === authState ? children : null;
  },
  SignInButton: ({ children }: { children: ReactNode }) => children,
  SignUpButton: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/app/larper-os", () => ({ larperOsClassName: "larper-os" }));
vi.mock("@/components/auth/try-demo", () => ({
  TryDemoButton: ({ className }: { className: string }) => <button className={className}>Try the demo</button>,
}));
vi.mock("@/components/quest/quest-home", () => ({ QuestHome: () => questHome() }));
vi.mock("@/components/track-landing", () => ({ TrackLanding: () => <span data-testid="track-landing" /> }));

afterEach(() => {
  authState = "signed-out";
  authPending = null;
  questHome.mockClear();
  vi.unstubAllEnvs();
});

it("shows a static loading shell until auth resolves and then renders the first quest immediately", async () => {
  let resolveAuth!: () => void;
  authPending = new Promise((resolve) => { resolveAuth = resolve; });
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    render(<Home />);
    expect(screen.getByText("larper os")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual(["larper"]);
    expect(screen.getByRole("status").textContent).toBe("loading larper…");
    expect(questHome).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    await act(async () => {
      authState = "signed-in";
      authPending = null;
      resolveAuth();
    });
    expect(screen.getByText("quest card")).toBeTruthy();
    expect(questHome).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).toBeNull();
  } finally {
    fetch.mockRestore();
  }
});

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
