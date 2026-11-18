import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Privacy } from "@/lib/api";
import { SignInRemovalFailed, YourData, type AccountKind } from "./your-data";

vi.mock("@/app/larper-os", () => ({ larperOsClassName: "larper-os" }));

const api = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  useApi: () => api,
}));

const settle = () => act(async () => {});
const onHistoryDeleted = vi.fn();
const onAccountDeleted = vi.fn();
const ALL: Privacy = { export: true, deleteHistory: true, deleteAccount: true };
const mount = (account: AccountKind = "user", privacy: Privacy = ALL) => render(
  <YourData
    account={account}
    privacy={privacy}
    onHistoryDeleted={onHistoryDeleted}
    onAccountDeleted={onAccountDeleted}
    onAccountDeletePendingChange={() => {}}
  />,
);
const button = (name: string) => screen.getByRole("button", { name });
const typeDelete = (word = "delete") =>
  fireEvent.change(screen.getByLabelText(/type .*delete.* to go ahead/), { target: { value: word } });

const readBlob = (b: Blob) =>
  new Promise<string>((res) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.readAsText(b);
  });

const counts = { quests: 3, checkInAttempts: 2, hoursAnswers: 1, savedPlaces: 1, events: 4 };

beforeEach(() => {
  api.mockReset();
  onHistoryDeleted.mockClear();
  onAccountDeleted.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("download my data", () => {
  let created: Blob[];
  let revoked: string[];
  let clicked: { href: string; download: string }[];

  beforeEach(() => {
    created = [];
    revoked = [];
    clicked = [];
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
      created.push(b as Blob);
      return "blob:export";
    });
    URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: new Date("2026-11-17T23:30:00Z") });
  });
  afterEach(() => vi.useRealTimers());

  it("asks the export endpoint, saves the JSON as a dated file, and lets go of the object URL", async () => {
    api.mockResolvedValue({ version: 1, journal: [] });
    mount();
    fireEvent.click(button("download my data"));
    await settle();
    expect(api).toHaveBeenCalledWith("/me/export");
    expect(await readBlob(created[0])).toContain('"version": 1');
    expect(clicked).toEqual([{ href: "blob:export", download: "larper-export-2026-11-17.json" }]);
    expect(revoked).toEqual([]); // not yet: iOS Safari may still be reading the blob
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(revoked).toEqual(["blob:export"]);
    expect(document.querySelector("a[download]")).toBeNull(); // the temporary link is gone
    expect(screen.getByRole("status").textContent).toContain("saved larper-export-2026-11-17.json.");
    expect(button("download my data").hasAttribute("disabled")).toBe(false);
  });

  it("says so, and saves nothing, when it fails", async () => {
    api.mockRejectedValue(new ApiError("boom", 500));
    mount();
    fireEvent.click(button("download my data"));
    await settle();
    expect(screen.getByRole("status").textContent).toBe("something went wrong on our end.");
    expect(created).toHaveLength(0);
    expect(clicked).toHaveLength(0);
  });

  it("tells a rate-limited person how long to wait", async () => {
    api.mockRejectedValue(new ApiError("slow down", 429, "http", undefined, 40));
    mount();
    fireEvent.click(button("download my data"));
    await settle();
    expect(screen.getByRole("status").textContent).toBe("that's too many tries in a row. wait about 40 seconds and try again.");
  });

  it("handles the API refusing the demo account", async () => {
    api.mockRejectedValue(new ApiError("demo", 403, "http", "demo_account"));
    mount();
    fireEvent.click(button("download my data"));
    await settle();
    expect(screen.getByRole("status").textContent).toContain("demo account has no data of its own");
  });
});

describe("demo and unknown accounts", () => {
  it("offers none of the three actions to the demo account, and says why", () => {
    mount("demo");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("the shared demo account has no data of its own to download or delete.")).toBeTruthy();
  });

  it.each<AccountKind>(["checking", "unknown"])("offers nothing while the account is %s", (kind) => {
    mount(kind);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("which controls show (the privacy flags from /me)", () => {
  const buttons = () => screen.queryAllByRole("button").map((b) => b.textContent);
  const off: Privacy = { export: false, deleteHistory: false, deleteAccount: false };

  it("all: download, delete my history and delete my account", () => {
    mount("user", ALL);
    expect(buttons()).toEqual(["download my data", "delete my history", "delete my account"]);
  });

  it("history only: no delete my account", () => {
    mount("user", { export: true, deleteHistory: true, deleteAccount: false });
    expect(buttons()).toEqual(["download my data", "delete my history"]);
  });

  it("off: only download, with one calm line", () => {
    mount("user", { export: true, deleteHistory: false, deleteAccount: false });
    expect(buttons()).toEqual(["download my data"]);
    expect(screen.getByText("deleting your data isn't available yet. you can still download it.")).toBeTruthy();
  });

  it("nothing on: no controls, one calm line", () => {
    mount("user", off);
    expect(buttons()).toEqual([]);
    expect(screen.getByText("downloading or deleting your data isn't available yet.")).toBeTruthy();
  });

  it("a delete flag without the export flag hides the download", () => {
    mount("user", { export: false, deleteHistory: true, deleteAccount: false });
    expect(buttons()).toEqual(["delete my history"]);
  });

  it("demo keeps its own line, whatever the flags say", () => {
    mount("demo", ALL);
    expect(buttons()).toEqual([]);
    expect(screen.getByText("the shared demo account has no data of its own to download or delete.")).toBeTruthy();
  });
});

describe("deletes_unavailable (503)", () => {
  const submit = () => fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);

  it.each(["history", "account"])("delete my %s says so calmly, and changes nothing", async (kind) => {
    api.mockRejectedValue(new ApiError("deleting isn't available yet", 503, "http", "deletes_unavailable"));
    mount();
    fireEvent.click(button(`delete my ${kind}`));
    typeDelete();
    submit();
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("deleting your data isn't available yet.");
    expect(onHistoryDeleted).not.toHaveBeenCalled();
    expect(onAccountDeleted).not.toHaveBeenCalled();
  });

  it("any other 503 stays the generic message", async () => {
    api.mockRejectedValue(new ApiError("boom", 503));
    mount();
    fireEvent.click(button("delete my history"));
    typeDelete();
    submit();
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("something went wrong on our end.");
  });
});

describe("no user-facing mention of days or hand removal", () => {
  it.each(["history", "account"])("the %s confirmation", (kind) => {
    mount();
    fireEvent.click(button(`delete my ${kind}`));
    expect(screen.getByRole("dialog").textContent).not.toMatch(/7 days|within \d+ days|by hand|manual|removed by/i);
  });
});

describe("delete my history", () => {
  it("opens a confirmation that says what goes and what stays, with focus moved into it", () => {
    mount();
    const opener = button("delete my history");
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "delete your history?" });
    expect(document.activeElement).toBe(dialog);
    expect(dialog.textContent).toContain("your journal: every quest you've been offered.");
    expect(dialog.textContent).toContain("your saved places.");
    expect(dialog.textContent).toContain("your taste profile: what you told larper you like, and what it has learned from your quests. quests carry on from there.");
    expect(dialog.textContent).toContain("about 3 weeks under the usual backup schedule");
    expect(dialog.textContent).toContain("60-day cleanup rule");
    expect(dialog.textContent).toContain("restoring a backup could bring deleted data back");
    expect(dialog.textContent).toContain("until its scheduled cleanup");
    expect(dialog.textContent).toContain("with no fixed deadline");
  });

  it("needs the word delete before it will go", () => {
    mount();
    fireEvent.click(button("delete my history"));
    const go = screen.getByRole("dialog").querySelector<HTMLButtonElement>("button[type=submit]")!;
    expect(go.hasAttribute("disabled")).toBe(true);
    typeDelete("delet");
    expect(go.hasAttribute("disabled")).toBe(true);
    typeDelete("Delete");
    expect(go.hasAttribute("disabled")).toBe(false);
    expect(api).not.toHaveBeenCalled();
  });

  it("cancel closes it, deletes nothing and puts focus back on the opener", () => {
    mount();
    const opener = button("delete my history");
    fireEvent.click(opener);
    fireEvent.click(button("cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(api).not.toHaveBeenCalled();
  });

  it("escape closes it too", () => {
    mount();
    const opener = button("delete my history");
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("deletes, shows progress, refreshes the journal and says what went", async () => {
    let finish!: (v: unknown) => void;
    api.mockReturnValue(new Promise((r) => (finish = r)));
    mount();
    fireEvent.click(button("delete my history"));
    typeDelete();
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    await settle();
    expect(api).toHaveBeenCalledWith("/me/history", { method: "DELETE" });
    expect(button("deleting…").hasAttribute("disabled")).toBe(true);
    expect(button("cancel").hasAttribute("disabled")).toBe(true);
    expect(onHistoryDeleted).not.toHaveBeenCalled();

    finish({ deleted: counts });
    await settle();
    expect(onHistoryDeleted).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "deleted 3 quests, 2 check-in attempts, 1 “was it open?” answer and 1 saved place.",
    );
    expect(onAccountDeleted).not.toHaveBeenCalled();
  });

  it("keeps the confirmation open with the error when it fails, and can try again", async () => {
    api.mockRejectedValueOnce(new ApiError("boom", 503));
    mount();
    fireEvent.click(button("delete my history"));
    typeDelete();
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("something went wrong on our end.");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onHistoryDeleted).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText(/to go ahead/));

    api.mockResolvedValueOnce({ deleted: counts });
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    await settle();
    expect(onHistoryDeleted).toHaveBeenCalledTimes(1);
  });

  it("says how long to wait on a 429", async () => {
    api.mockRejectedValue(new ApiError("slow", 429, "http", undefined, 200));
    mount();
    fireEvent.click(button("delete my history"));
    typeDelete();
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("wait about 4 minutes");
  });

  it("handles a 403 demo_account without breaking", async () => {
    api.mockRejectedValue(new ApiError("demo", 403, "http", "demo_account"));
    mount();
    fireEvent.click(button("delete my history"));
    typeDelete();
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("demo account has no data of its own");
    expect(onHistoryDeleted).not.toHaveBeenCalled();
  });
});

it.each(["history", "account"])("locks both delete actions while the %s confirmation is open or submitting", async (kind) => {
  let reject!: (error: ApiError) => void;
  api.mockReturnValue(new Promise((_, fail) => (reject = fail)));
  mount();
  const opener = button(`delete my ${kind}`);
  const other = button(kind === "history" ? "delete my account" : "delete my history");
  fireEvent.click(opener);
  expect(other.hasAttribute("disabled")).toBe(true);
  fireEvent.click(other);
  expect(screen.getByRole("dialog", { name: `delete your ${kind}?` })).toBeTruthy();

  typeDelete();
  const dialog = screen.getByRole("dialog");
  const form = dialog.querySelector("form")!;
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.click(other);
    fireEvent.keyDown(dialog, { key: "Escape" });
  });
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(other.hasAttribute("disabled")).toBe(true);
  const path = kind === "history" ? "/me/history" : "/me";
  expect(api.mock.calls).toEqual([[path, { method: "DELETE" }]]);

  reject(new ApiError("boom", 503));
  await settle();
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(other.hasAttribute("disabled")).toBe(true);
  fireEvent.click(button("cancel"));
  expect(other.hasAttribute("disabled")).toBe(false);
  expect(document.activeElement).toBe(opener);
});

describe("delete my account", () => {
  const confirmAccount = async () => {
    fireEvent.click(button("delete my account"));
    typeDelete();
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    await settle();
  };
  const accountCounts = { ...counts, tasteProfile: true, account: true };

  it("explains the account deletion and what happens to the sign-in", () => {
    mount();
    fireEvent.click(button("delete my account"));
    const dialog = screen.getByRole("dialog", { name: "delete your account?" });
    expect(document.activeElement).toBe(dialog);
    expect(dialog.textContent).toContain("your taste profile.");
    expect(dialog.textContent).toContain("your larper account.");
    expect(dialog.textContent).toContain("your sign-in.");
    expect(dialog.textContent).toContain("this deletes your larper data and your sign-in, then signs you out.");
    expect(dialog.textContent).toContain("you can sign up again later, but it will be a new account with none of this in it.");
    expect(dialog.textContent).toContain("about 3 weeks under the usual backup schedule");
    expect(dialog.textContent).toContain("restoring a backup could bring deleted data back");
    expect(dialog.textContent).not.toMatch(/7 days|within \d+ days|by hand|manual|clerk/i);
  });

  it("cancel closes it and returns focus to the opener", () => {
    mount();
    const opener = button("delete my account");
    fireEvent.click(opener);
    fireEvent.click(button("cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(api).not.toHaveBeenCalled();
  });

  it.each(["deleted", "failed"])("hands off completion for clerkUser %s", async (clerkUser) => {
    api.mockResolvedValue({ deleted: accountCounts, clerkUser });
    mount();
    await confirmAccount();
    expect(api).toHaveBeenCalledWith("/me", { method: "DELETE" });
    expect(onAccountDeleted).toHaveBeenCalledOnce();
    expect(onAccountDeleted).toHaveBeenCalledWith(clerkUser);
  });

  it("an error leaves the account alone and nobody signed out", async () => {
    api.mockRejectedValue(new ApiError("boom", 500));
    mount();
    await confirmAccount();
    expect(screen.getByRole("alert").textContent).toBe("something went wrong on our end.");
    expect(onAccountDeleted).not.toHaveBeenCalled();
  });
});

describe("DELETE /me answering 401 (Clerk no longer has the user)", () => {
  const gone = () => new ApiError("signed out", 401);

  it("on the first confirm it counts as deleted", async () => {
    api.mockRejectedValue(gone());
    mount();
    fireEvent.click(button("delete my account"));
    typeDelete();
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    await settle();
    expect(onAccountDeleted).toHaveBeenCalledExactlyOnceWith("deleted");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("on delete my history it stays an ordinary signed-out error", async () => {
    api.mockRejectedValue(gone());
    mount();
    fireEvent.click(button("delete my history"));
    typeDelete();
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("you've been signed out. sign in again to carry on.");
    expect(onAccountDeleted).not.toHaveBeenCalled();
    expect(onHistoryDeleted).not.toHaveBeenCalled();
  });

  it("on try again it counts as deleted", async () => {
    const onRemoved = vi.fn();
    api.mockRejectedValue(gone());
    render(<SignInRemovalFailed onRemoved={onRemoved} />);
    fireEvent.click(button("try again"));
    await settle();
    expect(onRemoved).toHaveBeenCalledOnce();
  });
});

describe("confirmation dialogs", () => {
  it.each(["history", "account"])("the %s dialog is described by its deletes and keeps", (kind) => {
    mount();
    fireEvent.click(button(`delete my ${kind}`));
    const dialog = screen.getByRole("dialog");
    const desc = document.getElementById(dialog.getAttribute("aria-describedby")!)!;
    expect(desc.textContent).toContain("this deletes:");
    expect(desc.textContent).toContain("saved places.");
    if (kind === "history") expect(desc.textContent).toContain("this keeps:");
    expect(document.activeElement).toBe(dialog);
  });
});

describe("sign-in removal failed", () => {
  it("says what happened, and try again repeats DELETE /me until it works", async () => {
    const onRemoved = vi.fn();
    api.mockResolvedValueOnce({ deleted: {}, clerkUser: "failed" }).mockResolvedValueOnce({ deleted: {}, clerkUser: "deleted" });
    render(<SignInRemovalFailed onRemoved={onRemoved} />);
    expect(screen.getByRole("heading", { name: "your larper data is deleted." })).toBeTruthy();
    expect(screen.getByText("removing your sign-in didn't go through, so you're still signed in.")).toBeTruthy();

    fireEvent.click(button("try again"));
    await settle();
    expect(api).toHaveBeenCalledWith("/me", { method: "DELETE" });
    expect(onRemoved).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("your sign-in is still there. try again in a bit.");

    fireEvent.click(button("try again"));
    await settle();
    expect(api).toHaveBeenCalledTimes(2);
    expect(onRemoved).toHaveBeenCalledOnce();
  });

  it("explains a failed retry, and a 503 unavailable, calmly", async () => {
    api.mockRejectedValueOnce(new ApiError("boom", 500)).mockRejectedValueOnce(new ApiError("x", 503, "http", "deletes_unavailable"));
    render(<SignInRemovalFailed onRemoved={() => {}} />);
    fireEvent.click(button("try again"));
    await settle();
    expect(screen.getByRole("status").textContent).toBe("something went wrong on our end.");
    fireEvent.click(button("try again"));
    await settle();
    expect(screen.getByRole("status").textContent).toBe("deleting your data isn't available yet.");
  });

  it("says nothing about days or removal by hand", () => {
    render(<SignInRemovalFailed onRemoved={() => {}} />);
    expect(document.body.textContent).not.toMatch(/7 days|within \d+ days|by hand|manual/i);
  });
});
