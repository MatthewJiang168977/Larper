import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type JournalEntry } from "@/lib/api";
import JournalPage from "./page";

vi.mock("@/components/require-sign-in", () => ({ RequireSignIn: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Analytics (lib/analytics.ts): what would be recorded.
const tracked = vi.hoisted(() => ({ events: [] as string[], known: false }));
vi.mock("@/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics")>()),
  track: (event: string) => void tracked.events.push(event),
  setDemo: (d: boolean) => void tracked.events.push(`demo=${d}`),
  demoKnown: () => tracked.known,
}));

let answer: () => Promise<unknown>;
let answerMe: () => Promise<unknown>;
const api = vi.fn((path: string) => (path === "/me" ? answerMe() : answer()));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  useApi: () => api,
}));

const settle = () => act(async () => {});
const entry = (over: Partial<JournalEntry>): JournalEntry => ({
  id: "1",
  status: "completed",
  createdAt: "2026-10-25T02:30:00Z", // 10:30 pm on Oct 24 in New York
  updatedAt: "2026-10-25T02:30:00Z",
  name: "Tasty Noodles",
  category: "noodle_shop",
  reasons: { liked: ["hand-pulled-noodles", "ramen"], rarest: null, indie: false },
  ...over,
});

beforeEach(() => {
  api.mockClear();
  tracked.events.length = 0;
  tracked.known = false;
  answerMe = () => Promise.resolve({ demo: false });
});

describe("Journal", () => {
  it("coming from the map: records that it was opened, once, without asking /me", async () => {
    tracked.known = true;
    answer = () => Promise.resolve([]);
    const { rerender } = render(<JournalPage />);
    rerender(<JournalPage />);
    await settle();
    expect(tracked.events).toEqual(["journal_opened"]);
    expect(api).not.toHaveBeenCalledWith("/me");
  });

  it.each([true, false])("on a fresh load: gets the demo flag (%s) from /me before recording", async (demo) => {
    answer = () => Promise.resolve([]);
    answerMe = () => Promise.resolve({ demo });
    render(<JournalPage />);
    await settle();
    expect(tracked.events).toEqual([`demo=${demo}`, "journal_opened"]);
    expect(api.mock.calls.filter(([path]) => path === "/me")).toHaveLength(1);
  });

  it("still records the visit, with no flag and no error shown, when /me fails", async () => {
    answer = () => Promise.resolve([entry({})]);
    answerMe = () => Promise.reject(new ApiError("nope", 503));
    render(<JournalPage />);
    await settle();
    expect(tracked.events).toEqual(["journal_opened"]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Tasty Noodles")).toBeTruthy();
  });

  it("doesn't record a second visit or ask /me again when the list is retried", async () => {
    answer = () => Promise.reject(new ApiError("x", 400));
    render(<JournalPage />);
    await settle();
    answer = () => Promise.resolve([]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(tracked.events).toEqual(["demo=false", "journal_opened"]);
    expect(api.mock.calls.filter(([path]) => path === "/me")).toHaveLength(1);
  });

  it("writes tags and categories in plain words, and dates in New York time", async () => {
    answer = () => Promise.resolve([entry({})]);
    render(<JournalPage />);
    await settle();
    expect(screen.getByText("noodle shop · for hand pulled noodles + ramen")).toBeTruthy();
    expect(screen.getByText("Oct 24")).toBeTruthy(); // not the 25th, whatever the device's zone
  });

  it("stamps today's open quest TODAY in oxblood", async () => {
    answer = () => Promise.resolve([entry({ status: "offered" })]);
    render(<JournalPage />);
    await settle();
    const stamp = screen.getByText("Today");
    expect(stamp.className).toContain("text-oxblood");
    expect(screen.queryByText("Offered")).toBeNull();
  });

  it("labels a simulated demo check-in, and only that", async () => {
    answer = () =>
      Promise.resolve([entry({ id: "1", name: "Pretend", simulated: true }), entry({ id: "2", name: "Real", simulated: false })]);
    render(<JournalPage />);
    await settle();
    expect(screen.getAllByText("Simulated check-in · demo account")).toHaveLength(1);
    expect(screen.getByText("Pretend").parentElement!.textContent).toContain("Simulated check-in");
  });

  it("draws no rules around an empty journal, and offers the way back to the map", async () => {
    answer = () => Promise.resolve([]);
    render(<JournalPage />);
    await settle();
    expect(screen.getByText("Blank pages. Your first quest is on the map.")).toBeTruthy();
    expect(document.querySelector("ol")).toBeNull();
    expect(screen.getByRole("link", { name: "← Back to the map" }).getAttribute("href")).toBe("/");
  });

  it("says what went wrong in plain words, never the server's, and tries again", async () => {
    answer = () => Promise.reject(new ApiError("unknown column q.simulated", 400));
    render(<JournalPage />);
    await settle();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Couldn't open the journal.");
    expect(alert.textContent).not.toContain("column");

    answer = () => Promise.resolve([entry({})]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Tasty Noodles")).toBeTruthy();
  });

  it("uses the app's network wording", async () => {
    answer = () => Promise.reject(new ApiError("Failed to fetch", 0, "network"));
    render(<JournalPage />);
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("Can't reach the server. Check your connection.");
  });
});
