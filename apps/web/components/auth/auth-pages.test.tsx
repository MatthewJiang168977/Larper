import { render, screen } from "@testing-library/react";
import { isValidElement, Suspense, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { larperOsAuthAppearance } from "./clerk-appearance";
import { signInAppearance } from "./demo-account";

const { SignIn, SignUp, ClerkLoading } = vi.hoisted(() => ({
  SignIn: () => <div data-testid="sign-in-form" />,
  SignUp: () => <div data-testid="sign-up-form" />,
  // Shown while clerk-js loads: rendered here as if it were still loading.
  ClerkLoading: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@clerk/nextjs", () => ({ SignIn, SignUp, ClerkLoading }));
vi.mock("@/app/larper-os", () => ({ larperOsClassName: "larper-os" }));
vi.mock("@/components/auth/try-demo", () => ({
  DemoPanel: ({ signUpMode }: { signUpMode?: string }) =>
    signUpMode === "restricted" ? <aside aria-label="demo" /> : null,
}));

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
// stream inside a Suspense boundary.
describe("sign-in and sign-up pages", () => {
  it("passes only appearance to Clerk's sign-in form and keeps it inside Suspense", () => {
    const hit = find(SignInPage(), SignIn);
    expect(hit?.path).toContain(Suspense);
    expect(hit?.el.props).toEqual({ appearance: signInAppearance(process.env.NEXT_PUBLIC_SIGNUP_MODE) });
  });

  it("passes only appearance to Clerk's sign-up form and keeps it inside Suspense", () => {
    const hit = find(SignUpPage(), SignUp);
    expect(hit?.path).toContain(Suspense);
    expect(hit?.el.props).toEqual({ appearance: larperOsAuthAppearance });
  });

  it.each([
    { Page: SignInPage, title: "sign in", form: "sign-in-form" },
    { Page: SignUpPage, title: "sign up", form: "sign-up-form" },
  ])("renders the $title form in a Larper OS window", ({ Page, title, form }) => {
    render(<Page />);
    const main = screen.getByRole("main");
    const window = screen.getByRole("region", { name: title });
    expect(main.classList.contains("larper-os")).toBe(true);
    expect(main.contains(screen.getByText("larper os"))).toBe(true);
    expect(main.contains(window)).toBe(true);
    expect(window.contains(screen.getByTestId(form))).toBe(true);
  });

  it("puts the restricted-mode demo after the sign-in form in the window", () => {
    vi.stubEnv("NEXT_PUBLIC_SIGNUP_MODE", "restricted");
    try {
      render(<SignInPage />);
      const window = screen.getByRole("region", { name: "sign in" });
      const demo = screen.getByRole("complementary", { name: "demo" });
      const form = screen.getByTestId("sign-in-form");
      expect(window.contains(demo)).toBe(true);
      expect(form.compareDocumentPosition(demo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { Page: SignInPage, title: "sign in", loading: "loading sign-in…" },
    { Page: SignUpPage, title: "sign up", loading: "loading sign-up…" },
  ])("$title: says it is loading while Clerk starts, and links privacy, terms and credits", ({ Page, loading }) => {
    render(<Page />);
    expect(screen.getAllByText(loading)).toHaveLength(1);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    const about = screen.getByRole("navigation", { name: "about larper" });
    for (const page of ["privacy", "terms", "credits"]) {
      const link = screen.getByRole("link", { name: page });
      expect(link.getAttribute("href")).toBe(`/${page}`);
      expect(about.contains(link)).toBe(true);
    }
  });
});
