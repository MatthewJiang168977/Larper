import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom has no ResizeObserver (quest-home measures the bottom sheet with one).
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;

// Nor IntersectionObserver (motion's in-view animations in the quest sheet use one).
class NoopIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.IntersectionObserver ??= NoopIntersectionObserver as unknown as typeof IntersectionObserver;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
