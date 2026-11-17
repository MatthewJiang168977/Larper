import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { YourData, type AccountKind } from "./your-data";

const signOut = vi.fn(() => Promise.resolve());
vi.mock("@clerk/nextjs", () => ({ useClerk: () => ({ signOut }) }));

const api = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  useApi: () => api,
}));

const settle = () => act(async () => {});
const onHistoryDeleted = vi.fn();
const mount = (account: AccountKind = "user") => render(<YourData account={account} onHistoryDeleted={onHistoryDeleted} />);
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
  signOut.mockClear();
  onHistoryDeleted.mockClear();
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
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-17T23:30:00Z") });
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

describe("delete my history", () => {
  it("opens a confirmation that says what goes and what stays, with focus moved into it", () => {
    mount();
    const opener = button("delete my history");
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "delete your history?" });
    expect(document.activeElement).toBe(dialog);
    expect(dialog.textContent).toContain("your journal: every quest you've been offered.");
    expect(dialog.textContent).toContain("your saved places.");
    expect(dialog.textContent).toContain("your taste profile: what you told larper you like");
    expect(dialog.textContent).toContain("about 3 weeks (60 days at the very most), and restoring a backup could bring deleted data back");
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
    expect(signOut).not.toHaveBeenCalled();
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

describe("delete my account", () => {
  const confirmAccount = async () => {
    fireEvent.click(button("delete my account"));
    typeDelete();
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    await settle();
  };
  const accountCounts = { ...counts, tasteProfile: 1, account: 1 };

  it("says what goes (the profile, the account, the clerk sign-in) and what stays", () => {
    mount();
    fireEvent.click(button("delete my account"));
    const dialog = screen.getByRole("dialog", { name: "delete your account?" });
    expect(document.activeElement).toBe(dialog);
    expect(dialog.textContent).toContain("your taste profile.");
    expect(dialog.textContent).toContain("your larper account. you'll be signed out.");
    expect(dialog.textContent).toContain("by hand within 7 days");
    expect(dialog.textContent).toContain("nothing in the app.");
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

  it("signs out to the landing page once Clerk has removed the user", async () => {
    api.mockResolvedValue({ deleted: accountCounts, clerkUser: "deleted" });
    mount();
    await confirmAccount();
    expect(api).toHaveBeenCalledWith("/me", { method: "DELETE" });
    expect(signOut).toHaveBeenCalledWith({ redirectUrl: "/" });
  });

  it.each([
    ["manual", "your larper data is deleted. your sign-in will be removed by hand within 7 days."],
    [
      "failed",
      "your larper data is deleted, but removing your sign-in didn't go through. we'll remove it by hand within 7 days.",
    ],
  ])("clerkUser %s: says so, then signs out when they leave", async (clerkUser, text) => {
    api.mockResolvedValue({ deleted: accountCounts, clerkUser });
    mount();
    await confirmAccount();
    expect(screen.getByRole("status").textContent).toContain(text);
    expect(signOut).not.toHaveBeenCalled();
    fireEvent.click(button("sign out and leave"));
    expect(signOut).toHaveBeenCalledWith({ redirectUrl: "/" });
  });

  it("an error leaves the account alone and nobody signed out", async () => {
    api.mockRejectedValue(new ApiError("boom", 500));
    mount();
    await confirmAccount();
    expect(screen.getByRole("alert").textContent).toBe("something went wrong on our end.");
    expect(signOut).not.toHaveBeenCalled();
  });
});
