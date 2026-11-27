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
const mocked = vi.hoisted(() => ({ phase: "day" as string }));
vi.mock("@clerk/nextjs", () => ({ SignIn, SignUp, ClerkLoading }));
vi.mock("@/app/larper-os", () => ({ larperOsClassName: "larper-os" }));
vi.mock("@/components/auth/try-demo", () => ({
  DemoPanel: ({ signUpMode }: { signUpMode?: string }) =>
    signUpMode === "restricted" ? <aside aria-label="demo" /> : null,
}));
vi.mock("@/components/map/map-daylight", () => ({ mapAppearanceAt: () => ({ phase: mocked.phase }) }));

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
    { Page: SignInPage, title: "sign in", intro: "welcome back. today's quest is waiting.", form: "sign-in-form" },
    { Page: SignUpPage, title: "new account", intro: "one quest a day, picked for you.", form: "sign-up-form" },
  ])("$title: one window with the title, a one-line intro, then Clerk's form", ({ Page, title, intro, form }) => {
    render(<Page />);
    const main = screen.getByRole("main");
    const window = screen.getByRole("region", { name: title });
    expect(main.classList.contains("larper-os")).toBe(true);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(title);
    expect(title).not.toMatch(/\.exe/);
    expect(window.contains(screen.getByTestId(form))).toBe(true);
    const line = screen.getByText(intro);
    expect(window.contains(line)).toBe(true);
    expect(line.compareDocumentPosition(screen.getByTestId(form)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing from the old shell: no logon band, mini map, teaser, pins or flag.
    expect(main.textContent).not.toMatch(/larper os 3\.1|side-quest edition|just_looking|signal:|today's quest:/);
    expect(main.querySelector(".larper-auth-pin, .larper-auth-minimap, .larper-auth-band, canvas, .maplibregl-map")).toBeNull();
  });

  it("follows the sun: the page carries the phase the wallpaper uses, for the window's tint", async () => {
    mocked.phase = "night";
    try {
      render(<SignInPage />);
      expect(await screen.findByRole("main")).toBeTruthy();
      expect(screen.getByRole("main").getAttribute("data-phase")).toBe("night");
      expect(document.querySelector("img")?.getAttribute("src")).toBe("/wallpaper/night-phone.webp");
    } finally {
      mocked.phase = "day";
    }
  });

  it("links to sign-in from the menu bar everywhere but sign-in itself", () => {
    const { unmount } = render(<SignInPage />);
    expect(screen.queryByRole("link", { name: "sign in" })).toBeNull();
    unmount();
    render(<SignUpPage />);
    expect(screen.getByRole("link", { name: "sign in" }).getAttribute("href")).toBe("/sign-in");
  });

  it("keeps the wallpaper out of the accessibility tree", () => {
    const { container } = render(<SignInPage />);
    const wallpaper = container.querySelector(".larper-auth-wallpaper");
    expect(wallpaper?.getAttribute("aria-hidden")).toBe("true");
    expect(wallpaper?.querySelector("img")?.getAttribute("alt")).toBe("");
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
  ])("$title: says it is loading while Clerk starts, and links privacy, terms and credits in the window's footer", ({ Page, title, loading }) => {
    render(<Page />);
    expect(screen.getAllByText(loading)).toHaveLength(1);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    const footer = screen.getByRole("region", { name: title === "sign in" ? "sign in" : "new account" }).querySelector("footer");
    const about = screen.getByRole("navigation", { name: "about larper" });
    expect(footer?.contains(about)).toBe(true);
    for (const page of ["privacy", "terms", "credits"]) {
      const link = screen.getByRole("link", { name: page });
      expect(link.getAttribute("href")).toBe(`/${page}`);
      expect(about.contains(link)).toBe(true);
    }
  });

  it("credits the map in one line under the window, outside it", () => {
    render(<SignInPage />);
    const credit = screen.getByText(/^map ©/);
    expect(credit.textContent).toBe("map © OpenStreetMap, OpenMapTiles");
    expect(screen.getByRole("region", { name: "sign in" }).contains(credit)).toBe(false);
    expect(screen.getByRole("link", { name: "OpenStreetMap" }).getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
  });
});
