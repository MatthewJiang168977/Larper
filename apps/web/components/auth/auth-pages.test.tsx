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
  DemoWindow: () => <aside aria-label="demo window" />,
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
    { Page: SignInPage, title: "sign_in.exe", form: "sign-in-form" },
    { Page: SignUpPage, title: "new_account.exe", form: "sign-up-form" },
  ])("renders Clerk's form in the $title window", ({ Page, title, form }) => {
    render(<Page />);
    const main = screen.getByRole("main");
    const window = screen.getByRole("region", { name: title });
    expect(main.classList.contains("larper-os")).toBe(true);
    expect(screen.getByText("side-quest edition")).toBeTruthy();
    expect(main.contains(window)).toBe(true);
    expect(window.contains(screen.getByTestId(form))).toBe(true);
  });

  it("links to sign-in from the menu bar everywhere but sign-in itself", () => {
    const { unmount } = render(<SignInPage />);
    expect(screen.queryByRole("link", { name: "sign in" })).toBeNull();
    unmount();
    render(<SignUpPage />);
    expect(screen.getByRole("link", { name: "sign in" }).getAttribute("href")).toBe("/sign-in");
  });

  it("teases today's quest without saying anything about it", () => {
    const { container } = render(<SignInPage />);
    expect(screen.getAllByRole("img", { name: "hidden until you sign in" })).toHaveLength(2);
    expect(container.textContent).toContain("sign in to see where");
    expect(container.textContent).not.toMatch(/tea room|min walk/);
  });

  it("keeps the pins and the flag out of the accessibility tree, with no live map", () => {
    const { container } = render(<SignInPage />);
    for (const pin of container.querySelectorAll(".larper-auth-pin")) {
      expect(pin.closest('[aria-hidden="true"]')).toBeTruthy();
    }
    expect(container.querySelector("canvas, .maplibregl-map")).toBeNull();
  });

  it("puts the restricted-mode demo after the sign-in form in the window", () => {
    vi.stubEnv("NEXT_PUBLIC_SIGNUP_MODE", "restricted");
    try {
      render(<SignInPage />);
      const window = screen.getByRole("region", { name: "sign_in.exe" });
      expect(window.contains(screen.getByRole("complementary", { name: "demo window" }))).toBe(false);
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
