import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestView } from "@/lib/api";
import { QuestSheet } from "./quest-sheet";

// The check-in stamp: it slams down once after "I went", never for a quest that loads
// already done, and under reduced motion it's simply there.
let reduce = false;
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => reduce,
}));

const done: QuestView = {
  id: "q1",
  status: "completed",
  score: 1,
  reasons: { liked: [], rarest: null, indie: false },
  createdAt: "",
  place: { id: "p1", name: "Cafe Uno", lat: 40.73, lng: -73.99, category: "cafe", tags: [], distanceM: 100, website: null, instagram: null, phone: null },
};

const sheet = (over: { stampSlam?: boolean; onStampSlammed?: () => void } = {}) =>
  render(
    <QuestSheet
      quest={done}
      deck={[]}
      selectedId={null}
      onSelect={vi.fn()}
      onAction={vi.fn()}
      busy={false}
      topLimit={120}
      onCoveredChange={vi.fn()}
      {...over}
    />,
  );
const stamp = () => Array.from(document.querySelectorAll("span")).find((s) => s.textContent === "Done")!;

let vibrate: ReturnType<typeof vi.fn>;
beforeEach(() => {
  reduce = false;
  vi.useFakeTimers();
  vibrate = vi.fn(() => true);
  Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "vibrate");
});

describe("QuestSheet: the Done stamp", () => {
  it("slams down after a check-in: says so once, buzzes 30 ms on impact", async () => {
    const slammed = vi.fn();
    sheet({ stampSlam: true, onStampSlammed: slammed });
    expect(stamp().hasAttribute("data-slam")).toBe(true);
    expect(slammed).toHaveBeenCalledTimes(1);
    expect(vibrate).not.toHaveBeenCalled(); // not before it lands
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith(30);
  });

  it("doesn't play again when the props change after it started", async () => {
    const slammed = vi.fn();
    const { rerender } = sheet({ stampSlam: true, onStampSlammed: slammed });
    rerender(
      <QuestSheet quest={done} deck={[]} selectedId={null} onSelect={vi.fn()} onAction={vi.fn()} busy topLimit={120} onCoveredChange={vi.fn()} />,
    );
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(slammed).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it("just sits there for a quest that loads already done: no slam, no buzz", async () => {
    sheet();
    expect(stamp().hasAttribute("data-slam")).toBe(false);
    expect(stamp().style.rotate).toBe("-3deg");
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("with reduced motion, shows the stamp still, and only buzzes", async () => {
    reduce = true;
    const slammed = vi.fn();
    sheet({ stampSlam: true, onStampSlammed: slammed });
    expect(stamp().hasAttribute("data-slam")).toBe(false);
    expect(slammed).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(vibrate).toHaveBeenCalledWith(30);
  });

  it("survives a browser without vibration, or one that refuses", async () => {
    Reflect.deleteProperty(navigator, "vibrate");
    sheet({ stampSlam: true });
    await act(() => vi.advanceTimersByTimeAsync(300));
    Object.defineProperty(navigator, "vibrate", {
      value: () => {
        throw new Error("blocked");
      },
      configurable: true,
    });
    sheet({ stampSlam: true });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(stamp()).toBeTruthy();
  });
});
