import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import OnboardingPage from "./page";

vi.mock("@/app/larper-os", () => ({ larperOsClassName: "larper-os" }));
vi.mock("@/components/require-sign-in", () => ({ RequireSignIn: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const CARDS = [
  { id: "a", title: "Old bookshops", blurb: "Dust and finds." },
  { id: "b", title: "Late-night noodles", blurb: "Steam." },
];
// Analytics (lib/analytics.ts): what would be recorded.
const tracked = vi.hoisted(() => ({ events: [] as string[], demo: [] as boolean[] }));
vi.mock("@/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics")>()),
  track: (event: string) => void tracked.events.push(event),
  setDemo: (d: boolean) => void tracked.demo.push(d),
}));

let cards: () => Promise<unknown>;
let save: () => Promise<unknown>;
const posts: unknown[] = [];
const api = vi.fn((path: string, init?: RequestInit) => {
  if (path === "/onboarding/cards") return cards();
  posts.push(JSON.parse(String(init?.body)));
  return save();
});
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  useApi: () => api,
}));

const settle = () => act(async () => {});
const into = () => fireEvent.click(screen.getByRole("button", { name: "Into it →" }));
const notReally = () => fireEvent.click(screen.getByRole("button", { name: "← Not really" }));

beforeEach(() => {
  posts.length = 0;
  tracked.events.length = 0;
  tracked.demo.length = 0;
  cards = () => Promise.resolve(CARDS);
  save = () => Promise.resolve({ topTags: ["hand-pulled-noodles"] });
});

describe("Onboarding", () => {
  it("opens with a line on what to do, and announces each card", async () => {
    render(<OnboardingPage />);
    await settle();
    expect(screen.getByText(/Swipe right on what you're into/)).toBeTruthy();
    const counter = screen.getByRole("status");
    expect(counter.getAttribute("aria-live")).toBe("polite");
    expect(counter.textContent).toBe("Vibe 1 of 2: Old bookshops");
    into();
    expect(counter.textContent).toBe("Vibe 2 of 2: Late-night noodles");
  });

  it("takes back the last answer", async () => {
    render(<OnboardingPage />);
    await settle();
    expect(screen.queryByText("Undo last answer")).toBeNull(); // nothing to undo yet
    notReally();
    fireEvent.click(screen.getByText("Undo last answer"));
    expect(screen.getByText("Old bookshops", { selector: "h2" })).toBeTruthy();
    into();
    into();
    await settle();
    expect(posts).toEqual([{ liked: ["a", "b"], passed: [] }]);
  });

  it("ends on the stamped 'Your quest log is open', in plain words, with today's quest", async () => {
    render(<OnboardingPage />);
    await settle();
    into();
    notReally();
    await settle();
    expect(screen.getByRole("heading", { name: "Your quest log is open" })).toBeTruthy();
    expect(screen.getByText("hand pulled noodles")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See today's quest" }).getAttribute("href")).toBe("/");
    expect(tracked.events).toEqual(["onboarding_finished"]);
    expect(tracked.demo).toEqual([false]);
  });

  it("records onboarding as finished only once it's saved, with the demo flag from the answer", async () => {
    save = () => Promise.reject(new ApiError("Internal server error", 500));
    render(<OnboardingPage />);
    await settle();
    into();
    notReally();
    await settle();
    expect(tracked.events).toEqual([]);

    save = () => Promise.resolve({ topTags: [], demo: true });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(tracked.events).toEqual(["onboarding_finished"]);
    expect(tracked.demo).toEqual([true]);
  });

  it("can undo the last pass after passing on everything", async () => {
    render(<OnboardingPage />);
    await settle();
    notReally();
    notReally();
    fireEvent.click(screen.getByText("Undo last answer"));
    expect(screen.getByText("Late-night noodles", { selector: "h2" })).toBeTruthy();
  });

  it("says a failed save in plain words, and Try again sends the same answers", async () => {
    save = () => Promise.reject(new ApiError("unknown card z in liked", 400));
    render(<OnboardingPage />);
    await settle();
    into();
    notReally();
    await settle();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Couldn't save your answers.");
    expect(alert.textContent).not.toContain("unknown card");

    save = () => Promise.resolve({ topTags: [] });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(posts).toEqual([
      { liked: ["a"], passed: ["b"] },
      { liked: ["a"], passed: ["b"] },
    ]);
    expect(screen.getByRole("heading", { name: "Your quest log is open" })).toBeTruthy();
  });

  it("says when the cards can't load, and tries again", async () => {
    cards = () => Promise.reject(new ApiError("x", 0, "timeout"));
    render(<OnboardingPage />);
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("The server is taking too long to answer.");
    cards = () => Promise.resolve(CARDS);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(screen.getByRole("status").textContent).toContain("Vibe 1 of 2");
  });
});
