import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TrackLanding } from "./track-landing";

const log = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/analytics", () => ({
  track: (event: string) => void log.push(event),
  setDemo: (d: boolean) => void log.push(`demo=${d}`),
}));

beforeEach(() => {
  log.length = 0;
});

describe("TrackLanding", () => {
  it("resets the demo flag before recording the view, once per mount, and renders nothing", () => {
    const { container, rerender } = render(<TrackLanding />);
    rerender(<TrackLanding />);
    expect(log).toEqual(["demo=false", "landing_viewed"]);
    expect(container.innerHTML).toBe("");
  });
});
