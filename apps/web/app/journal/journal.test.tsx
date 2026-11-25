import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type JournalEntry } from "@/lib/api";
import JournalPage from "./page";

let auth: { isLoaded: boolean; userId: string | null; sessionId: string | null };
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
vi.mock("@/app/larper-os", () => ({ larperOsClassName: "larper-os" }));
vi.mock("@/components/require-sign-in", () => ({
  RequireSignIn: ({ children }: { children: React.ReactNode }) =>
    auth.userId ? children : <p>redirecting to sign-in</p>,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, replace, ...rest }: { href: string; children: React.ReactNode; replace?: boolean }) => (
    <a href={href} data-replace={replace} {...rest}>
      {children}
    </a>
  ),
}));

// Analytics (lib/analytics.ts): what would be recorded.
const tracked = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock("@/lib/analytics", async (importOriginal) => {
  const analytics = await importOriginal<typeof import("@/lib/analytics")>();
  return {
    ...analytics,
    track: (event: string) => void tracked.events.push(event),
    setDemo: (d: boolean) => {
      analytics.setDemo(d);
      tracked.events.push(`demo=${d}`);
    },
  };
});
const { clearDemo, setDemo: seedDemo } = await vi.importActual<typeof import("@/lib/analytics")>("@/lib/analytics");

let answer: () => Promise<unknown>;
let answerMe: () => Promise<unknown>;
const api = vi.fn((path: string) => (path === "/me" ? answerMe() : answer()));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  useApi: () => api,
}));

const settle = () => act(async () => {});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const entry = (over: Partial<JournalEntry>): JournalEntry => ({
  id: "1",
  status: "completed",
  createdAt: "2026-10-25T02:30:00Z", // 10:30 pm on oct 24 in New York
  updatedAt: "2026-10-25T02:30:00Z",
  name: "Tasty Noodles",
  category: "noodle_shop",
  reasons: { liked: ["hand-pulled-noodles", "ramen"], rarest: null, indie: false },
  ...over,
});

beforeEach(() => {
  api.mockClear();
  auth = { isLoaded: true, userId: "user-a", sessionId: "session-a" };
  tracked.events.length = 0;
  clearDemo();
  answerMe = () => Promise.resolve({ demo: false });
});

describe("Journal", () => {
  it("checks /me even with a cached analytics flag, and records nothing while waiting", async () => {
    seedDemo(false);
    answer = () => Promise.resolve([]);
    const me = deferred<{ demo: boolean }>();
    answerMe = () => me.promise;
    render(<JournalPage />);
    await settle();
    expect(api).toHaveBeenCalledWith("/me");
    expect(tracked.events).toEqual([]);

    me.resolve({ demo: true });
    await settle();
    expect(tracked.events).toEqual(["demo=true", "journal_opened"]);
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
    seedDemo(false);
    answerMe = () => Promise.reject(new ApiError("nope", 503));
    render(<JournalPage />);
    await settle();
    expect(tracked.events).toEqual(["journal_opened"]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Tasty Noodles")).toBeTruthy();
    for (const name of ["download my data", "delete my history", "delete my account"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("doesn't record a second visit or ask /me again when the list is retried", async () => {
    answer = () => Promise.reject(new ApiError("x", 400));
    render(<JournalPage />);
    await settle();
    answer = () => Promise.resolve([]);
    fireEvent.click(screen.getByRole("button", { name: "try again" }));
    await settle();
    expect(tracked.events).toEqual(["demo=false", "journal_opened"]);
    expect(api.mock.calls.filter(([path]) => path === "/me")).toHaveLength(1);
  });

  it("writes tags and categories in plain words, and dates in New York time", async () => {
    answer = () => Promise.resolve([entry({})]);
    render(<JournalPage />);
    await settle();
    expect(screen.getByText("noodle shop · for hand pulled noodles + ramen")).toBeTruthy();
    expect(screen.getByText("oct 24")).toBeTruthy(); // not the 25th, whatever the device's zone
  });

  it("labels today's open quest Today", async () => {
    answer = () => Promise.resolve([entry({ status: "offered" })]);
    render(<JournalPage />);
    await settle();
    expect(screen.getByText("today").getAttribute("data-state")).toBe("offered");
    expect(screen.queryByText("Offered")).toBeNull();
  });

  it("labels a simulated demo check-in, and only that", async () => {
    answer = () =>
      Promise.resolve([entry({ id: "1", name: "Pretend", simulated: true }), entry({ id: "2", name: "Real", simulated: false })]);
    render(<JournalPage />);
    await settle();
    expect(screen.getAllByText("simulated check-in · demo account")).toHaveLength(1);
    expect(screen.getByText("Pretend").parentElement!.textContent).toContain("simulated check-in");
  });

  it("draws no rules around an empty journal, and offers the way back to the map", async () => {
    answer = () => Promise.resolve([]);
    render(<JournalPage />);
    await settle();
    expect(screen.getByText("blank pages. your first quest is on the map.")).toBeTruthy();
    expect(document.querySelector("ol")).toBeNull();
    expect(screen.getByRole("link", { name: "back to the map" }).getAttribute("href")).toBe("/");
  });

  it("says what went wrong in plain words, never the server's, and tries again", async () => {
    answer = () => Promise.reject(new ApiError("unknown column q.simulated", 400));
    render(<JournalPage />);
    await settle();
    const alert = screen.getByRole("alert");
    expect(screen.getByRole("heading", { name: "couldn't open the journal" })).toBeTruthy();
    expect(alert.textContent).toContain("try again to reopen your quest history.");
    expect(alert.textContent).not.toContain("column");

    answer = () => Promise.resolve([entry({})]);
    fireEvent.click(screen.getByRole("button", { name: "try again" }));
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Tasty Noodles")).toBeTruthy();
  });

  it("uses the app's network wording", async () => {
    answer = () => Promise.reject(new ApiError("Failed to fetch", 0, "network"));
    render(<JournalPage />);
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("can't reach the server. check your connection.");
  });

  it("has no data controls of its own: they are in the account window", async () => {
    answer = () => Promise.resolve([entry({})]);
    render(<JournalPage />);
    await settle();
    expect(screen.queryByRole("region", { name: "your data" })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete|download/ })).toBeNull();
    expect(screen.getByRole("link", { name: "back to the map" })).toBeTruthy();
  });

  it.each([
    { userId: "user-b", sessionId: "session-a" },
    { userId: "user-a", sessionId: "session-b" },
  ])("clears entries and ignores late replies when the identity becomes %j", async (identity) => {
    const oldQuests = deferred<JournalEntry[]>();
    answer = () => oldQuests.promise;
    const { rerender } = render(<JournalPage />);
    await settle();
    auth = { ...auth, ...identity };
    answer = () => Promise.resolve([]);
    rerender(<JournalPage />);
    await settle();
    oldQuests.resolve([entry({})]);
    await settle();
    expect(screen.queryByText("Tasty Noodles")).toBeNull();
    expect(api.mock.calls.filter(([path]) => path === "/me")).toHaveLength(2);
  });
});
