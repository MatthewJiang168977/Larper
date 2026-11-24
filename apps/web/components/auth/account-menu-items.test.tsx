import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const Marker = (name: string) => Object.assign(() => null, { displayName: name });
vi.mock("@clerk/nextjs", () => ({
  UserButton: { MenuItems: Marker("MenuItems"), Link: Marker("Link"), Action: Marker("Action") },
}));
const { accountMenuItems } = await import("./account-menu-items");

const items = (opts?: { weeklyEmail?: boolean }) => {
  const root = accountMenuItems(opts) as ReactElement<{ children: ReactNode }>;
  return (Array.isArray(root.props.children) ? root.props.children : [root.props.children])
    .filter((c): c is ReactElement<{ label: string; href?: string }> => isValidElement(c))
    .map((c) => ({ label: c.props.label, href: c.props.href }));
};

describe("accountMenuItems", () => {
  it("lists manage account, journal, your data and privacy; Clerk keeps sign out last", () => {
    expect(items()).toEqual([
      { label: "manageAccount", href: undefined },
      { label: "journal", href: "/journal" },
      { label: "your data", href: "/journal#your-data" },
      { label: "privacy", href: "/privacy" },
    ]);
  });

  it("adds the weekly email page only when it is on", () => {
    expect(items({ weeklyEmail: true }).map((i) => i.label)).toContain("weekly email");
    expect(items().map((i) => i.label)).not.toContain("weekly email");
  });
});
