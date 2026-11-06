import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TrackView } from "./track-view";

const tracked = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/analytics", () => ({ track: (event: string) => void tracked.push(event) }));

describe("TrackView", () => {
  it("records the view once per mount, and renders nothing", () => {
    const { container, rerender } = render(<TrackView event="landing_viewed" />);
    rerender(<TrackView event="landing_viewed" />);
    expect(tracked).toEqual(["landing_viewed"]);
    expect(container.innerHTML).toBe("");
  });
});
