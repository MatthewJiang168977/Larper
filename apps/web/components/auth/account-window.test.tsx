import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userProfileAppearance } from "./clerk-appearance";

vi.mock("@/app/larper-os", () => ({ larperOsClassName: "larper-os" }));
const api = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  useApi: () => api,
}));
const pages: string[] = [];
vi.mock("@clerk/nextjs", () => {
  const UserProfile = Object.assign(
    ({ children }: { children?: ReactNode }) => <div data-testid="clerk-profile">{children}</div>,
    { Page: ({ label, children }: { label: string; children: ReactNode }) => { pages.push(label); return <div data-testid={`page-${label}`}>{children}</div>; } },
  );
  return { UserProfile, useUser: () => ({ user: null }), useAuth: () => ({ sessionId: "s1" }), useClerk: () => ({ signOut: vi.fn() }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("./account-data-page", () => ({ AccountDataPage: () => <p>data controls</p> }));

const { AccountWindow } = await import("./account-window");
const settle = () => act(async () => {});

beforeEach(() => { api.mockReset(); pages.length = 0; });

describe("AccountWindow", () => {
  it("shows Clerk's profile with a \"your data\" page for a regular account", async () => {
    api.mockResolvedValue({ demo: false });
    render(<AccountWindow />);
    await settle();
    expect(screen.getByTestId("clerk-profile")).toBeTruthy();
    expect(pages).toContain("your data");
    expect(screen.getByText("data controls")).toBeTruthy();
  });

  it("gives the shared demo account a note instead of Clerk's forms", async () => {
    api.mockResolvedValue({ demo: true });
    render(<AccountWindow />);
    await settle();
    expect(screen.queryByTestId("clerk-profile")).toBeNull();
    expect(screen.getByText("the shared demo account has no settings of its own.")).toBeTruthy();
  });
});

describe("userProfileAppearance", () => {
  it("hides Clerk's own delete-account section and uses OS section labels", () => {
    const e = userProfileAppearance(null).elements as Record<string, unknown>;
    expect(e["profileSection__danger"]).toEqual({ display: "none" });
    expect(e.profileSectionTitleText).toMatchObject({ textTransform: "lowercase" });
    expect(JSON.stringify(e.profileSectionTitleText)).not.toMatch(/pixel/);
  });
});
