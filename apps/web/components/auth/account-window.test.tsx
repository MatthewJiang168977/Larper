import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_KEPT } from "@/components/larper-os/data-copy";
import { ApiError } from "@/lib/api";
import { userProfileAppearance } from "./clerk-appearance";

vi.mock("@/app/larper-os", () => ({ larperOsClassName: "larper-os" }));
const signOut = vi.fn<(keepPage: () => void, options: { sessionId: string }) => Promise<void>>();
const replace = vi.fn();
let auth: { isLoaded: boolean; userId: string | null; sessionId: string | null };
// Which of Larper's pages Clerk's profile is showing, as its tabs would choose.
let tab: string;
vi.mock("@clerk/nextjs", () => {
  const Page = ({ label, children }: { label: string; children?: ReactNode }) =>
    children && label === tab ? <div>{children}</div> : <span data-testid="tab">{label}</span>;
  const UserProfile = Object.assign(
    ({ children }: { children?: ReactNode }) => <div data-testid="clerk-profile">{children}</div>,
    { Page },
  );
  return {
    UserProfile,
    SignOutButton: ({ children }: { children: ReactNode }) => <>{children}</>,
    useUser: () => ({ user: null }),
    useAuth: () => auth,
    useClerk: () => ({ signOut }),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/components/require-sign-in", () => ({
  RequireSignIn: ({ children }: { children: ReactNode }) => (auth.userId ? children : <p>redirecting to sign-in</p>),
}));

let answerMe: () => Promise<unknown>;
let answerDelete: () => Promise<unknown>;
const api = vi.fn((path: string, init?: RequestInit) =>
  init?.method === "DELETE" ? answerDelete() : path === "/me" ? answerMe() : Promise.resolve({ enabled: false }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  useApi: () => api,
}));

const { AccountWindow } = await import("./account-window");
const ALL = { export: true, deleteHistory: true, deleteAccount: true };
const NAMES = ["download my data", "delete my history", "delete my account"];
const shown = () => NAMES.filter((name) => screen.queryByRole("button", { name }));
const settle = () => act(async () => {});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((r) => (resolve = r)), resolve };
};
const open = async (me: unknown = { demo: false, privacy: ALL }) => {
  answerMe = () => Promise.resolve(me);
  const view = render(<AccountWindow />);
  await settle();
  return view;
};
const confirmDelete = () => {
  fireEvent.click(screen.getByRole("button", { name: "delete my account" }));
  fireEvent.change(screen.getByLabelText(/to go ahead/), { target: { value: "delete" } });
  fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
};

beforeEach(() => {
  api.mockClear();
  signOut.mockReset().mockResolvedValue(undefined);
  replace.mockClear();
  auth = { isLoaded: true, userId: "user-a", sessionId: "session-a" };
  tab = "your data";
});

describe("AccountWindow", () => {
  it("keeps Clerk's profile and security pages, with your data inside it", async () => {
    await open();
    expect(screen.getByTestId("clerk-profile")).toBeTruthy();
    expect(screen.getAllByTestId("tab").map((t) => t.textContent)).toEqual(["account", "security"]);
    expect(screen.getByRole("button", { name: "sign out" })).toBeTruthy();
    for (const { name, what } of DATA_KEPT) {
      expect(screen.getByText(name)).toBeTruthy();
      expect(screen.getByText(what)).toBeTruthy();
    }
  });

  it("adds the weekly email page only when it is switched on", async () => {
    tab = "weekly email";
    await open();
    expect(screen.queryByText("weekly email")).toBeNull();
  });

  it("shows only the controls /me reports as on", async () => {
    await open({ demo: false, privacy: { export: true, deleteHistory: false, deleteAccount: false } });
    expect(shown()).toEqual(["download my data"]);
  });

  it("treats a missing privacy field as everything off", async () => {
    await open({ demo: false });
    expect(shown()).toEqual([]);
  });

  it("gives the demo account no delete actions and none of Clerk's forms", async () => {
    await open({ demo: true, privacy: ALL });
    expect(screen.queryByTestId("clerk-profile")).toBeNull();
    expect(shown()).toEqual([]);
    expect(screen.getByText("the shared demo account has no settings of its own.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "sign out" })).toBeTruthy();
  });

  it("offers nothing of Clerk's while it can't tell whether this is the demo, and tries again", async () => {
    answerMe = () => Promise.reject(new ApiError("nope", 503));
    render(<AccountWindow />);
    await settle();
    expect(screen.queryByTestId("clerk-profile")).toBeNull();
    expect(shown()).toEqual([]);
    answerMe = () => Promise.resolve({ demo: false, privacy: ALL });
    fireEvent.click(screen.getByRole("button", { name: "try again" }));
    await settle();
    expect(shown()).toEqual(NAMES);
  });

  it("marks account deletion with a red edge, never the pool primary", async () => {
    await open();
    const opener = screen.getByRole("button", { name: "delete my account" });
    expect(opener.hasAttribute("data-danger")).toBe(true);
    fireEvent.click(opener);
    const confirm = screen.getByRole("dialog").querySelector('button[type="submit"]')!;
    expect(confirm.hasAttribute("data-danger")).toBe(true);
    expect(confirm.className).not.toContain("primary");
  });

  it("hides Clerk's own delete-account section", () => {
    const e = userProfileAppearance(null).elements as Record<string, unknown>;
    expect(e.profileSection__danger).toEqual({ display: "none" });
    expect(e.profilePage__danger).toEqual({ display: "none" });
  });
});

describe("account deletion", () => {
  const done = () => expect(screen.getByRole("status").textContent).toContain("your larper data is deleted.");

  it.each([
    ["deleted", () => Promise.resolve({ clerkUser: "deleted" })],
    ["account_gone", () => Promise.reject(new ApiError("gone", 401, "http", "account_gone"))],
  ])("%s: signs out that session, keeps the message, then goes home", async (_, reply) => {
    answerDelete = reply;
    const signingOut = deferred<void>();
    signOut.mockReturnValue(signingOut.promise);
    const { rerender } = await open();
    confirmDelete();
    await settle();
    expect(signOut).toHaveBeenCalledWith(expect.any(Function), { sessionId: "session-a" });
    done();
    expect(screen.queryByTestId("clerk-profile")).toBeNull();

    auth = { isLoaded: true, userId: null, sessionId: null };
    rerender(<AccountWindow />);
    done();
    signingOut.resolve();
    await settle();
    expect(replace).toHaveBeenCalledWith("/");
    expect(screen.queryByText("redirecting to sign-in")).toBeNull();
  });

  it("failed sign-in removal: stays signed in, and try again finishes it", async () => {
    const replies = [{ clerkUser: "failed" }, { clerkUser: "deleted" }];
    answerDelete = () => Promise.resolve(replies.shift());
    await open();
    confirmDelete();
    await settle();
    expect(signOut).not.toHaveBeenCalled();
    expect(screen.getByText(/removing your sign-in didn't go through yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "try again" }));
    await settle();
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("still signs out if the visitor has switched tab while it was deleting", async () => {
    const purge = deferred<{ clerkUser: string }>();
    answerDelete = () => purge.promise;
    const { rerender } = await open();
    confirmDelete();
    tab = "security";
    rerender(<AccountWindow />);
    expect(screen.queryByRole("button", { name: "delete my account" })).toBeNull();
    purge.resolve({ clerkUser: "deleted" });
    await settle();
    expect(signOut).toHaveBeenCalledOnce();
    done();
  });

  it("ignores a reply that arrives after the session changed", async () => {
    const purge = deferred<{ clerkUser: string }>();
    answerDelete = () => purge.promise;
    const { rerender } = await open();
    confirmDelete();
    auth = { ...auth, userId: "user-b", sessionId: "session-b" };
    rerender(<AccountWindow />);
    await settle();
    purge.resolve({ clerkUser: "deleted" });
    await settle();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("offers a retry when sign-out fails, without deleting again", async () => {
    signOut.mockRejectedValueOnce(new Error("sign-out failed"));
    answerDelete = () => Promise.resolve({ clerkUser: "deleted" });
    await open();
    confirmDelete();
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("couldn't sign you out");
    const calls = api.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "retry sign-out" }));
    await settle();
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenCalledTimes(calls);
  });
});
