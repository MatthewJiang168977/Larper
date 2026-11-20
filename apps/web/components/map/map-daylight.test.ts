import { describe, expect, it } from "vitest";
import { mapStyleAtTime } from "./map-daylight";

const style = (instant: string) => mapStyleAtTime(new Date(instant));

describe("NYC map daylight", () => {
  it("switches at the calculated sunrise and sunset minutes", () => {
    expect(style("2026-12-21T07:16:59-05:00")).toBe("night");
    expect(style("2026-12-21T07:17:00-05:00")).toBe("day");
    expect(style("2026-12-21T16:31:59-05:00")).toBe("day");
    expect(style("2026-12-21T16:32:00-05:00")).toBe("night");
  });

  it("stays on the NYC date through UTC midnight and stays dark through NYC midnight", () => {
    expect(style("2026-06-22T00:00:00Z")).toBe("day");
    expect(style("2026-06-22T00:30:59Z")).toBe("day");
    expect(style("2026-06-22T00:31:00Z")).toBe("night");
    expect(style("2026-06-21T23:59:59-04:00")).toBe("night");
    expect(style("2026-06-22T00:00:00-04:00")).toBe("night");
  });

  it("handles the skipped spring hour and the later clock time of sunrise", () => {
    expect(style("2026-03-07T06:20:00-05:00")).toBe("day");
    expect(style("2026-03-08T01:59:59-05:00")).toBe("night");
    expect(style("2026-03-08T03:00:00-04:00")).toBe("night");
    expect(style("2026-03-08T07:18:59-04:00")).toBe("night");
    expect(style("2026-03-08T07:19:00-04:00")).toBe("day");
  });

  it("stays dark in both copies of the repeated fall hour and uses standard time at sunrise", () => {
    expect(style("2026-11-01T01:30:00-04:00")).toBe("night");
    expect(style("2026-11-01T01:30:00-05:00")).toBe("night");
    expect(style("2026-11-01T06:25:59-05:00")).toBe("night");
    expect(style("2026-11-01T06:26:00-05:00")).toBe("day");
  });
});
