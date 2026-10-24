import { describe, expect, it } from "vitest";
import { FLICK_PX_S, fullHeight, offsetFor, resolveSnap, snapForKey } from "./sheet-snap";

describe("resolveSnap", () => {
  const range = 400; // peek sits 400 px below full

  it("lands on the nearer snap when let go slowly", () => {
    expect(resolveSnap(150, 0, range, "peek", -250)).toBe("full");
    expect(resolveSnap(250, 0, range, "full", 250)).toBe("peek");
  });

  it("goes the way it was thrown, wherever it is", () => {
    expect(resolveSnap(30, FLICK_PX_S + 1, range, "full", 30)).toBe("peek");
    expect(resolveSnap(380, -(FLICK_PX_S + 1), range, "peek", -20)).toBe("full");
  });

  it("treats a press that barely moved as a tap, which toggles", () => {
    expect(resolveSnap(398, 0, range, "peek", -2)).toBe("full");
    expect(resolveSnap(3, 0, range, "full", 3)).toBe("peek");
  });
});

describe("offsetFor / fullHeight", () => {
  it("puts full at 0 and peek at the difference, never negative", () => {
    expect(offsetFor("full", 600, 150)).toBe(0);
    expect(offsetFor("peek", 600, 150)).toBe(450);
    expect(offsetFor("peek", 100, 150)).toBe(0);
  });

  it("stops full below the notices, and never below peek", () => {
    expect(fullHeight(800, 200, 150)).toBe(592);
    expect(fullHeight(800, 760, 150)).toBe(150);
  });
});

describe("snapForKey", () => {
  it("maps the handle's arrow and Home/End keys", () => {
    expect(snapForKey("ArrowUp")).toBe("full");
    expect(snapForKey("ArrowDown")).toBe("peek");
    expect(snapForKey("End")).toBe("full");
    expect(snapForKey("Home")).toBe("peek");
    expect(snapForKey("Enter")).toBeNull(); // the button's click handles Enter and Space
    expect(snapForKey("a")).toBeNull();
  });
});
