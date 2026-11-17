import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type JournalEntry } from "@/lib/api";
import JournalPage from "./page";

const signOut = vi.fn<(keepPage: () => void, options: { sessionId: string }) => Promise<void>>();
const replace = vi.fn();
let auth: { isLoaded: boolean; userId: string | null; sessionId: string | null };
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth, useClerk: () => ({ signOut }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
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
const tracked = vi.hoisted(() => ({ events: [] as string[], known: false }));
vi.mock("@/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics")>()),
  track: (event: string) => void tracked.events.push(event),
  setDemo: (d: boolean) => void tracked.events.push(`demo=${d}`),
  demoKnown: () => tracked.known,
  demoFlag: () => tracked.known ? false : undefined,
  clearDemo: () => { tracked.known = false; },
}));

let answer: () => Promise<unknown>;
let answerMe: () => Promise<unknown>;
let answerDelete: () => Promise<unknown>;
const api = vi.fn((path: string, init?: RequestInit) =>
  path === "/me" && !init?.method ? answerMe() : init?.method === "DELETE" ? answerDelete() : answer(),
);
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  useApi: () => api,
}));

const settle = () => act(async () => {});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const deleteData = (kind: "history" | "account") => {
  fireEvent.click(screen.getByRole("button", { name: `delete my ${kind}` }));
  fireEvent.change(screen.getByLabelText(/to go ahead/), { target: { value: "delete" } });
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
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
  signOut.mockReset().mockResolvedValue(undefined);
  replace.mockClear();
  tracked.events.length = 0;
  tracked.known = false;
  answerMe = () => Promise.resolve({ demo: false });
});

describe("Journal", () => {
  it("checks /me even with a cached analytics flag and fails closed while waiting", async () => {
    tracked.known = true;
    answer = () => Promise.resolve([]);
    const me = deferred<{ demo: boolean }>();
    answerMe = () => me.promise;
    render(<JournalPage />);
    await settle();
    expect(api).toHaveBeenCalledWith("/me");
    expect(screen.getByText("checking your account…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "delete my account" })).toBeNull();

    me.resolve({ demo: true });
    await settle();
    expect(tracked.events).toEqual(["demo=true", "journal_opened"]);
    expect(screen.queryByRole("button", { name: "delete my account" })).toBeNull();
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
    tracked.known = true;
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

  describe("your data", () => {
    it("is offered at the bottom of the journal to a signed-in person", async () => {
      answer = () => Promise.resolve([entry({})]);
      render(<JournalPage />);
      await settle();
      expect(screen.getByRole("region", { name: "your data" })).toBeTruthy();
      for (const name of ["download my data", "delete my history", "delete my account"]) {
        expect(screen.getByRole("button", { name })).toBeTruthy();
      }
    });

    it("is replaced by one line for the shared demo account", async () => {
      answer = () => Promise.resolve([entry({})]);
      answerMe = () => Promise.resolve({ demo: true });
      render(<JournalPage />);
      await settle();
      expect(screen.queryByRole("button", { name: "download my data" })).toBeNull();
      expect(screen.queryByRole("button", { name: "delete my history" })).toBeNull();
      expect(screen.queryByRole("button", { name: "delete my account" })).toBeNull();
      expect(screen.getByText("the shared demo account has no data of its own to download or delete.")).toBeTruthy();
    });

    it("after deleting history, the list is emptied and asked for again", async () => {
      answer = () => Promise.resolve([entry({})]);
      answerDelete = () => Promise.resolve({ deleted: { quests: 1, checkInAttempts: 0, hoursAnswers: 0, savedPlaces: 0, events: 1 } });
      render(<JournalPage />);
      await settle();
      expect(screen.getByText("Tasty Noodles")).toBeTruthy();
      const listCalls = () => api.mock.calls.filter(([p, i]) => p === "/quests" && !i).length;
      const before = listCalls();

      answer = () => Promise.resolve([]);
      deleteData("history");
      await settle();
      expect(screen.queryByText("Tasty Noodles")).toBeNull();
      expect(screen.getByText("blank pages. your first quest is on the map.")).toBeTruthy();
      expect(listCalls()).toBe(before + 1);
    });

    it("ignores the pre-clear quest reply even if it arrives after the fresh list", async () => {
      const oldQuests = deferred<JournalEntry[]>();
      answer = () => oldQuests.promise;
      answerDelete = () => Promise.resolve({ deleted: { quests: 1, checkInAttempts: 0, hoursAnswers: 0, savedPlaces: 0, events: 1 } });
      render(<JournalPage />);
      await settle();
      answer = () => Promise.resolve([]);
      deleteData("history");
      await settle();
      expect(screen.getByText("blank pages. your first quest is on the map.")).toBeTruthy();

      oldQuests.resolve([entry({})]);
      await settle();
      expect(screen.queryByText("Tasty Noodles")).toBeNull();
    });

    it.each([
      { userId: "user-b", sessionId: "session-a" },
      { userId: "user-a", sessionId: "session-b" },
    ])("clears entries and confirmation, then checks /me again for %j", async (identity) => {
      answer = () => Promise.resolve([entry({})]);
      const { rerender } = render(<JournalPage />);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "delete my history" }));
      expect(screen.getByRole("dialog")).toBeTruthy();

      const me = deferred<{ demo: boolean }>();
      answerMe = () => me.promise;
      answer = () => Promise.resolve([]);
      auth = { ...auth, ...identity };
      rerender(<JournalPage />);
      expect(screen.queryByText("Tasty Noodles")).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("button", { name: "download my data" })).toBeNull();
      expect(screen.getByText("checking your account…")).toBeTruthy();
      expect(api.mock.calls.filter(([path]) => path === "/me")).toHaveLength(2);

      me.resolve({ demo: true });
      await settle();
      expect(screen.getByText(/shared demo account has no data/)).toBeTruthy();
    });

    it("ignores pending /me and /quests replies from the previous identity", async () => {
      const oldQuests = deferred<JournalEntry[]>();
      const oldMe = deferred<{ demo: boolean }>();
      answerMe = () => oldMe.promise;
      answer = () => oldQuests.promise;
      const { rerender } = render(<JournalPage />);
      await settle();

      auth = { ...auth, userId: "user-b", sessionId: "session-b" };
      answerMe = () => Promise.reject(new ApiError("nope", 503));
      answer = () => Promise.resolve([]);
      rerender(<JournalPage />);
      await settle();
      oldMe.resolve({ demo: false });
      oldQuests.resolve([entry({})]);
      await settle();
      expect(screen.queryByText("Tasty Noodles")).toBeNull();
      expect(screen.queryByRole("button", { name: "delete my account" })).toBeNull();
      expect(screen.getByText(/couldn't check your account/)).toBeTruthy();
      expect(tracked.events).toEqual(["journal_opened"]);
    });
  });

  describe("account purge completion", () => {
    beforeEach(() => {
      answer = () => Promise.resolve([entry({})]);
    });

    it.each([
      ["deleted", "your larper data is deleted."],
      ["manual", "larper didn't remove your clerk sign-in."],
      ["failed", "larper couldn't remove your clerk sign-in."],
    ])("immediately tries to sign out after the %s outcome and hides the signed-in UI", async (clerkUser, message) => {
      const signOutPending = deferred<void>();
      signOut.mockReturnValue(signOutPending.promise);
      answerDelete = () => Promise.resolve({ clerkUser });
      const { rerender } = render(<JournalPage />);
      await settle();
      deleteData("account");
      await settle();
      expect(signOut).toHaveBeenCalledOnce();
      expect(signOut).toHaveBeenCalledWith(expect.any(Function), { sessionId: "session-a" });
      expect(screen.getByRole("status").textContent).toContain(message);
      expect(screen.queryByText("Tasty Noodles")).toBeNull();
      expect(screen.queryByRole("link")).toBeNull();
      expect(screen.queryByRole("button", { name: "delete my account" })).toBeNull();

      const callsAtPurge = api.mock.calls.length;
      auth = { isLoaded: false, userId: null, sessionId: null };
      rerender(<JournalPage />);
      expect(screen.getByRole("status").textContent).toContain(message);
      auth = { ...auth, isLoaded: true };
      signOutPending.resolve(undefined);
      rerender(<JournalPage />);
      await settle();
      expect(api).toHaveBeenCalledTimes(callsAtPurge);
      expect(screen.queryByText("redirecting to sign-in")).toBeNull();
      if (clerkUser === "deleted") {
        expect(replace).toHaveBeenCalledWith("/");
      } else {
        expect(replace).not.toHaveBeenCalled();
        expect(screen.getByRole("status").textContent).toContain(message);
        expect(screen.getByRole("link", { name: "back to larper" }).getAttribute("href")).toBe("/");
      }
    });

    it("doesn't sign out the new identity if the old account purge finishes after a switch", async () => {
      const purge = deferred<{ clerkUser: string }>();
      answerDelete = () => purge.promise;
      const { rerender } = render(<JournalPage />);
      await settle();
      deleteData("account");

      auth = { ...auth, userId: "user-b", sessionId: "session-b" };
      rerender(<JournalPage />);
      await settle();
      purge.resolve({ clerkUser: "manual" });
      await settle();
      expect(signOut).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "delete my account" })).toBeTruthy();
    });

    it("retries only sign-out after it fails, preserving the completion and Clerk status", async () => {
      signOut.mockRejectedValueOnce(new Error("sign-out failed"));
      answerDelete = () => Promise.resolve({ clerkUser: "failed" });
      render(<JournalPage />);
      await settle();
      deleteData("account");
      await settle();
      expect(screen.getByRole("status").textContent).toContain("your larper data is deleted.");
      expect(screen.getByRole("status").textContent).toContain("larper couldn't remove your clerk sign-in.");
      expect(screen.getByRole("alert").textContent).toContain("couldn't sign you out");
      expect(screen.queryByRole("link")).toBeNull();
      const callsAtPurge = api.mock.calls.length;

      fireEvent.click(screen.getByRole("button", { name: "retry sign-out" }));
      await settle();
      expect(signOut).toHaveBeenCalledTimes(2);
      expect(api).toHaveBeenCalledTimes(callsAtPurge);
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
