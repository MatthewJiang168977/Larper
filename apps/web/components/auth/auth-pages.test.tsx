import { isValidElement, Suspense, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const { SignIn, SignUp } = vi.hoisted(() => ({ SignIn: () => null, SignUp: () => null }));
vi.mock("@clerk/nextjs", () => ({ SignIn, SignUp }));
vi.mock("@/components/auth/try-demo", () => ({ DemoPanel: () => null }));

const { default: SignInPage } = await import("@/app/sign-in/[[...sign-in]]/page");
const { default: SignUpPage } = await import("@/app/sign-up/[[...sign-up]]/page");

// The element (and its ancestors' types) for the first node of `type` in a tree.
function find(node: ReactNode, type: unknown, path: unknown[] = []): { el: ReactElement; path: unknown[] } | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = find(n, type, path);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return { el: node, path };
  return find((node.props as { children?: ReactNode }).children, type, [...path, node.type]);
}

// Clerk's forms read the URL at request time, so under Cache Components they must
// stream inside a Suspense boundary; the theme comes from <ClerkProvider>.
describe("sign-in and sign-up pages", () => {
  it("render Clerk's sign-in form inside Suspense, with its own sign-up-link rule only", () => {
    const hit = find(SignInPage(), SignIn);
    expect(hit?.path).toContain(Suspense);
    const appearance = (hit!.el.props as { appearance?: unknown }).appearance;
    expect(appearance === undefined || JSON.stringify(appearance).includes("footerAction")).toBe(true);
  });

  it("render Clerk's sign-up form inside Suspense", () => {
    expect(find(SignUpPage(), SignUp)?.path).toContain(Suspense);
  });
});
