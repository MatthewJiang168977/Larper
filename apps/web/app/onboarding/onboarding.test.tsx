import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const into = () => fireEvent.click(screen.getByRole("button", { name: "into it →" }));
const notReally = () => fireEvent.click(screen.getByRole("button", { name: "← not really" }));

function startSwipe() {
  vi.stubGlobal("PointerEvent", MouseEvent);
  const card = screen.getByRole("heading", { name: CARDS[0].title }).parentElement!;
  card.setPointerCapture = vi.fn();
  fireEvent.pointerDown(card, { clientX: 150 });
  return card;
}

afterEach(() => vi.unstubAllGlobals());

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
    expect(screen.getByText(/swipe right on what you're into/)).toBeTruthy();
    const counter = screen.getByRole("status");
    expect(counter.getAttribute("aria-live")).toBe("polite");
    expect(counter.textContent).toBe("vibe 1 of 2: Old bookshops");
    into();
    expect(counter.textContent).toBe("vibe 2 of 2: Late-night noodles");
  });

  it("takes back the last answer", async () => {
    render(<OnboardingPage />);
    await settle();
    expect(screen.queryByText("undo last answer")).toBeNull(); // nothing to undo yet
    notReally();
    fireEvent.click(screen.getByText("undo last answer"));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Old bookshops" }));
    into();
    into();
    await settle();
    expect(posts).toEqual([{ liked: ["a", "b"], passed: [] }]);
  });

  it("ends on the stamped 'your quest log is open', in plain words, with today's quest", async () => {
    render(<OnboardingPage />);
    await settle();
    into();
    notReally();
    await settle();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "your quest log is open" }));
    expect(screen.getByText("hand pulled noodles")).toBeTruthy();
    expect(screen.getByRole("link", { name: "see today's quest" }).getAttribute("href")).toBe("/");
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
    fireEvent.click(screen.getByRole("button", { name: "try again" }));
    await settle();
    expect(tracked.events).toEqual(["onboarding_finished"]);
    expect(tracked.demo).toEqual([true]);
  });

  it("can undo the last pass after passing on everything", async () => {
    render(<OnboardingPage />);
    await settle();
    notReally();
    notReally();
    fireEvent.click(screen.getByText("undo last answer"));
    expect(screen.getByText("Late-night noodles", { selector: "h2" })).toBeTruthy();
  });

  it("says a failed save in plain words, and try again sends the same answers", async () => {
    save = () => Promise.reject(new ApiError("unknown card z in liked", 400));
    render(<OnboardingPage />);
    await settle();
    into();
    notReally();
    await settle();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("couldn't save your answers.");
    expect(alert.textContent).not.toContain("unknown card");

    save = () => Promise.resolve({ topTags: [] });
    fireEvent.click(screen.getByRole("button", { name: "try again" }));
    await settle();
    expect(posts).toEqual([
      { liked: ["a"], passed: ["b"] },
      { liked: ["a"], passed: ["b"] },
    ]);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "your quest log is open" }));
  });

  it("says when the cards can't load, and tries again", async () => {
    cards = () => Promise.reject(new ApiError("x", 0, "timeout"));
    render(<OnboardingPage />);
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("The server is taking too long to answer.");
    cards = () => Promise.resolve(CARDS);
    fireEvent.click(screen.getByRole("button", { name: "try again" }));
    await settle();
    expect(screen.getByRole("status").textContent).toContain("vibe 1 of 2");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Old bookshops" }));
  });

  it.each([-89, 89])("keeps the card after a %dpx swipe", async (distance) => {
    render(<OnboardingPage />);
    await settle();
    const card = startSwipe();
    fireEvent.pointerMove(card, { clientX: 150 + distance });
    fireEvent.pointerUp(card, { clientX: 150 + distance });
    expect(screen.getByRole("heading", { name: CARDS[0].title })).toBeTruthy();
  });

  it.each([
    [-91, { liked: ["b"], passed: ["a"] }],
    [91, { liked: ["a", "b"], passed: [] }],
  ])("answers in the direction of a %dpx swipe", async (distance, expected) => {
    render(<OnboardingPage />);
    await settle();
    const card = startSwipe();
    fireEvent.pointerMove(card, { clientX: 150 + distance });
    fireEvent.pointerUp(card, { clientX: 150 + distance });
    expect(screen.getByRole("heading", { name: CARDS[1].title })).toBeTruthy();
    into();
    await settle();
    expect(posts).toEqual([expected]);
  });

  it("resets a cancelled swipe without answering", async () => {
    render(<OnboardingPage />);
    await settle();
    const card = startSwipe();
    fireEvent.pointerMove(card, { clientX: 250 });
    expect(card.style.transform).toContain("translateX(100px)");
    fireEvent.pointerCancel(card);
    expect(card.style.transform).toContain("translateX(0px)");
    expect(card.getAttribute("data-dragging")).toBe("false");
    expect(screen.getByRole("heading", { name: CARDS[0].title })).toBeTruthy();
  });

  it("answers with ArrowLeft and ArrowRight", async () => {
    render(<OnboardingPage />);
    await settle();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await settle();
    expect(posts).toEqual([{ liked: ["b"], passed: ["a"] }]);
  });

  it("ignores repeated, modified and text-field arrow keys", async () => {
    render(<><input aria-label="text field" /><OnboardingPage /></>);
    await settle();
    for (const options of [{ repeat: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      fireEvent.keyDown(window, { key: "ArrowRight", ...options });
    }
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { name: CARDS[0].title })).toBeTruthy();
    expect(posts).toEqual([]);
  });
});
