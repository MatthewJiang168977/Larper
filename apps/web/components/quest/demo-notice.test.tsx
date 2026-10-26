import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Located } from "@/hooks/use-location";
import { DEMO_REASONS, DemoNotice, DISMISS_KEY } from "./demo-notice";

const midtown = (reason: Located["reason"]): Located => ({
  lat: 40.7549,
  lng: -73.984,
  source: "demo",
  reason,
  spot: "Midtown",
});
const washSq = (reason: Located["reason"]): Located => ({ lat: 40.7308, lng: -73.9973, source: "demo", reason });

const onRetry = vi.fn();
const renderNotice = (loc: Located, { demo = true, retrying = false } = {}) =>
  render(<DemoNotice loc={loc} demo={demo} onRetry={onRetry} retrying={retrying} />);
const toggle = () => screen.getByRole("button", { expanded: false });

beforeEach(() => {
  sessionStorage.clear();
  onRetry.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("DemoNotice: one line", () => {
  it.each(["waiting", "denied", "unavailable"] as const)("%s: DEMO · MIDTOWN · Use my location", (reason) => {
    renderNotice(midtown(reason));
    const notice = screen.getByRole("region", { name: "Demo area" });
    expect(toggle().textContent).toContain("Demo · Midtown");
    expect(screen.getByRole("button", { name: "Use my location" })).toBeTruthy();
    // Not an alert, and nothing that reads as a failure on the line itself.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(details(notice).hidden).toBe(true);
  });

  it.each(["no-gps", "outside"] as const)("%s: no location action, since asking again can't help", (reason) => {
    renderNotice(midtown(reason));
    expect(toggle().textContent).toContain("Demo · Midtown");
    expect(screen.queryByRole("button", { name: "Use my location" })).toBeNull();
  });

  it("doesn't say 'demo' to a regular account", () => {
    renderNotice(washSq("denied"), { demo: false });
    const notice = screen.getByRole("region", { name: "Map area" });
    expect(toggle().textContent).toContain("Washington Square");
    expect(notice.textContent).not.toMatch(/demo/i);
  });

  it("shows a retry in progress", () => {
    renderNotice(midtown("waiting"), { retrying: true });
    expect((screen.getByRole("button", { name: "Looking…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks the browser again from the line", () => {
    renderNotice(midtown("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Use my location" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

const details = (notice: HTMLElement) => document.getElementById(toggleOf(notice).getAttribute("aria-controls")!)!;
const toggleOf = (notice: HTMLElement) => notice.querySelector<HTMLElement>("[aria-expanded]")!;

describe("DemoNotice: the details", () => {
  it.each(Object.keys(DEMO_REASONS) as (keyof typeof DEMO_REASONS)[])("%s: leads with the area, then why", (reason) => {
    renderNotice(midtown(reason));
    const notice = screen.getByRole("region", { name: "Demo area" });
    fireEvent.click(toggle());
    expect(toggleOf(notice).getAttribute("aria-expanded")).toBe("true");
    const text = details(notice);
    expect(text.hidden).toBe(false);
    expect(text.textContent).toMatch(new RegExp(`^You're exploring Midtown, the demo's home base\\. ${escape(DEMO_REASONS[reason])}`));
  });

  it("opens and closes, with the action moving into the details", () => {
    renderNotice(midtown("denied"));
    const notice = screen.getByRole("region", { name: "Demo area" });
    fireEvent.click(toggle());
    const action = screen.getByRole("button", { name: "Use my location" });
    expect(details(notice).contains(action)).toBe(true);
    fireEvent.click(action);
    expect(onRetry).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { expanded: true }));
    expect(toggleOf(notice).getAttribute("aria-expanded")).toBe("false");
    expect(details(notice).hidden).toBe(true);
    expect(details(notice).contains(screen.getByRole("button", { name: "Use my location" }))).toBe(false);
  });

  it("names a regular account's stand-in area without the word demo", () => {
    renderNotice(washSq("unavailable"), { demo: false });
    fireEvent.click(toggle());
    expect(details(screen.getByRole("region", { name: "Map area" })).textContent).toContain(
      "You're exploring Washington Square, not your own neighborhood. Your device couldn't get a location fix.",
    );
  });
});

describe("DemoNotice: dismissed for the visit", () => {
  it("stays hidden across remounts once dismissed", () => {
    const { unmount } = renderNotice(midtown("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Hide for this visit" }));
    expect(screen.queryByRole("region", { name: "Demo area" })).toBeNull();
    expect(sessionStorage.getItem(DISMISS_KEY)).toBe("1");
    unmount();

    renderNotice(midtown("waiting"));
    expect(screen.queryByRole("region", { name: "Demo area" })).toBeNull();
  });

  it("works when storage is blocked: renders, dismisses, and stays dismissed until reload", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const { unmount } = renderNotice(midtown("denied"));
    expect(screen.getByRole("region", { name: "Demo area" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide for this visit" }));
    expect(screen.queryByRole("region", { name: "Demo area" })).toBeNull();
    unmount();

    renderNotice(midtown("denied"));
    expect(screen.queryByRole("region", { name: "Demo area" })).toBeNull();
  });
});

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
