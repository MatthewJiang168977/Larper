import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsAuth } from "./analytics-auth";

const clerk = vi.hoisted(() => ({ isLoaded: true, userId: null as string | null | undefined }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => clerk }));

const clearDemo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ clearDemo }));

function mountAs(userId: string | null | undefined, isLoaded = true) {
  Object.assign(clerk, { userId, isLoaded });
  const view = render(<AnalyticsAuth />);
  return (nextId: string | null | undefined, nextLoaded = true) => {
    Object.assign(clerk, { userId: nextId, isLoaded: nextLoaded });
    view.rerender(<AnalyticsAuth />);
  };
}

beforeEach(() => clearDemo.mockClear());

describe("AnalyticsAuth", () => {
  it("clears the flag on sign-out", () => {
    const become = mountAs("user_demo");
    become(null);
    expect(clearDemo).toHaveBeenCalledTimes(1);
  });

  it("clears the flag when the account changes", () => {
    const become = mountAs("user_demo");
    become("user_real");
    expect(clearDemo).toHaveBeenCalledTimes(1);
  });

  it("leaves it alone on a sign-in from signed-out (Try the demo set it already)", () => {
    const become = mountAs(null);
    become("user_demo");
    expect(clearDemo).not.toHaveBeenCalled();
  });

  it("leaves it alone while Clerk loads and while the account stays the same", () => {
    const become = mountAs(undefined, false);
    become("user_demo");
    become("user_demo");
    expect(clearDemo).not.toHaveBeenCalled();
  });

  it("treats Clerk going back to loading as no change", () => {
    const become = mountAs("user_demo");
    become(undefined, false);
    expect(clearDemo).not.toHaveBeenCalled();
    become("user_demo");
    expect(clearDemo).not.toHaveBeenCalled();
  });
});
