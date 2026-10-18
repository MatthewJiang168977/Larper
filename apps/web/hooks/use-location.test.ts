import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOCATE_TIMEOUT_MS, useLocation } from "./use-location";

// A geolocation stub that lets each test decide when (and whether) the browser answers.
let onFix: PositionCallback;
let onError: PositionErrorCallback;
const geolocation = {
  watchPosition: vi.fn((ok: PositionCallback, err: PositionErrorCallback) => {
    onFix = ok;
    onError = err;
    return 1;
  }),
  clearWatch: vi.fn(),
};
const PERMISSION_DENIED = 1;
const TIMEOUT = 3;
const error = (code: number) =>
  ({ code, PERMISSION_DENIED, POSITION_UNAVAILABLE: 2, TIMEOUT, message: "" }) as GeolocationPositionError;
const fix = (lat: number, lng: number, accuracy = 15) =>
  ({ coords: { latitude: lat, longitude: lng, accuracy } }) as GeolocationPosition;

beforeEach(() => {
  Object.defineProperty(navigator, "geolocation", { value: geolocation, configurable: true });
});

describe("useLocation", () => {
  it("waits for the first fix, then reports it", () => {
    const { result } = renderHook(() => useLocation());
    expect(result.current).toBeNull();
    act(() => onFix(fix(40.7, -74)));
    expect(result.current).toMatchObject({ lat: 40.7, lng: -74, source: "gps", accuracyM: 15 });
  });

  it("falls back to the demo spot when location is denied", () => {
    const { result } = renderHook(() => useLocation());
    act(() => onError(error(PERMISSION_DENIED)));
    expect(result.current).toMatchObject({ source: "demo", note: "Location is off. Showing Washington Square." });
  });

  it("falls back to the demo spot when the browser times out", () => {
    const { result } = renderHook(() => useLocation());
    act(() => onError(error(TIMEOUT)));
    expect(result.current).toMatchObject({ source: "demo", note: "Couldn't get a GPS fix. Showing Washington Square." });
  });

  it("falls back after LOCATE_TIMEOUT_MS when the prompt is never answered", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useLocation());
    act(() => vi.advanceTimersByTime(LOCATE_TIMEOUT_MS - 1));
    expect(result.current).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toMatchObject({ source: "demo", note: "Still waiting for your location. Showing Washington Square." });

    // A real fix still wins when it finally comes.
    act(() => onFix(fix(40.7, -74)));
    expect(result.current).toMatchObject({ source: "gps", lat: 40.7 });
  });

  it("keeps the same object on repeated errors (no refetch loop)", () => {
    const { result } = renderHook(() => useLocation());
    act(() => onError(error(TIMEOUT)));
    const first = result.current;
    act(() => onError(error(TIMEOUT)));
    expect(result.current).toBe(first);
  });

  it("keeps a real fix through a later error", () => {
    const { result } = renderHook(() => useLocation());
    act(() => onFix(fix(40.7, -74)));
    act(() => onError(error(TIMEOUT)));
    expect(result.current).toMatchObject({ source: "gps", lat: 40.7 });
  });
});
