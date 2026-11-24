// Accessibility checks with axe-core on the four pages people use: sign-in, quest,
// journal and account. A serious or critical violation fails the test, and so CI.
// jsdom has no layout or painted colour, so axe's contrast rule can't run here; contrast
// is covered by test/design-tokens.test.ts, and the rule list below says what is skipped.
import axe from "axe-core";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/larper-os", () => ({ larperOsClassName: "larper-os" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), usePathname: () => "/" }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
const api = vi.fn<(path: string) => Promise<unknown>>(async () => ({ demo: false, privacy: {} }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  useApi: () => api,
}));
vi.mock("@clerk/nextjs", () => {
  const UserProfile = Object.assign(
    ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    { Page: ({ children }: { children: ReactNode }) => <div>{children}</div> },
  );
  const UserButton = Object.assign(() => <button type="button">account</button>, {
    MenuItems: ({ children }: { children?: ReactNode }) => <>{children}</>, Link: () => null, Action: () => null,
  });
  return {
    SignIn: () => <form aria-label="sign in form"><label>email<input type="email" /></label><button type="submit">continue</button></form>,
    SignUp: () => null,
    ClerkLoading: () => null,
    UserProfile, UserButton,
    useUser: () => ({ user: null }),
    useAuth: () => ({ isLoaded: true, userId: "u", sessionId: "s" }),
    useClerk: () => ({ signOut: vi.fn() }),
    SignOutButton: ({ children }: { children: ReactNode }) => children,
    Show: ({ children }: { children: ReactNode }) => children,
    RedirectToSignIn: () => null,
    useSignIn: () => ({ signIn: {} }),
  };
});

// axe asks a canvas to detect icon fonts; jsdom has none and only logs a warning.
HTMLCanvasElement.prototype.getContext = (() => null) as never;

async function violations(ui: ReactNode) {
  const { container } = render(<main>{ui}</main>);
  await act(async () => {});
  const results = await axe.run(container, {
    resultTypes: ["violations"],
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}
const report = (v: Awaited<ReturnType<typeof violations>>) =>
  v.map((x) => `${x.id}: ${x.help} (${x.nodes.map((n) => n.target.join(" ")).join(", ")})`);

describe("axe: no serious accessibility violations", () => {
  it("catches a real violation (the check can fail)", async () => {
    expect(report(await violations(<input type="text" />)).join()).toMatch(/label/);
  });

  it("sign-in", async () => {
    const { default: SignInPage } = await import("@/app/sign-in/[[...sign-in]]/page");
    expect(report(await violations(<SignInPage />))).toEqual([]);
  });

  it("quest", async () => {
    const { QuestScreenFixture } = await import("@/app/design-lab/quest/quest-screen-fixture");
    expect(report(await violations(<QuestScreenFixture />))).toEqual([]);
  });

  it("journal", async () => {
    const { JournalView } = await import("@/components/larper-os/journal");
    const entries = [{
      id: "1", status: "completed" as const, createdAt: "2026-10-25T02:30:00Z", updatedAt: "2026-10-25T02:30:00Z",
      name: "Tasty Noodles", category: "noodle_shop", reasons: { liked: ["ramen"], rarest: null, indie: false },
    }];
    expect(report(await violations(<JournalView entries={entries} error={null} retry={() => {}} />))).toEqual([]);
  });

  // The account area on main today is the weekly-email page (Clerk's own profile can't render
  // in jsdom). Once the OS account window (/account) lands, point this at its page too.
  it("account", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEEKLY_EMAIL_ENABLED", "1");
    const { default: AccountPage } = await import("@/app/account/weekly-email/page");
    expect(report(await violations(<AccountPage />))).toEqual([]);
    vi.unstubAllEnvs();
  });
});
