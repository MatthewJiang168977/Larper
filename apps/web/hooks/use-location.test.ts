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
    expect(result.current.loc).toBeNull();
    act(() => onFix(fix(40.7, -74)));
    expect(result.current.loc).toMatchObject({ lat: 40.7, lng: -74, source: "gps", accuracyM: 15 });
  });

  it("falls back to the demo spot when location is denied", () => {
    const { result } = renderHook(() => useLocation());
    act(() => onError(error(PERMISSION_DENIED)));
    expect(result.current.loc).toMatchObject({ source: "demo", reason: "denied" });
  });

  it("falls back to the demo spot when the browser times out", () => {
    const { result } = renderHook(() => useLocation());
    act(() => onError(error(TIMEOUT)));
    expect(result.current.loc).toMatchObject({ source: "demo", reason: "unavailable" });
  });

  it("falls back after LOCATE_TIMEOUT_MS when the prompt is never answered", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useLocation());
    act(() => vi.advanceTimersByTime(LOCATE_TIMEOUT_MS - 1));
    expect(result.current.loc).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.loc).toMatchObject({ source: "demo", reason: "waiting" });

    // A real fix still wins when it finally comes.
    act(() => onFix(fix(40.7, -74)));
    expect(result.current.loc).toMatchObject({ source: "gps", lat: 40.7 });
  });

  it("keeps the same object on repeated errors (no refetch loop)", () => {
    const { result } = renderHook(() => useLocation());
    act(() => onError(error(TIMEOUT)));
    const first = result.current.loc;
    act(() => onError(error(TIMEOUT)));
    expect(result.current.loc).toBe(first);
  });

  it("keeps a real fix through a later error", () => {
    const { result } = renderHook(() => useLocation());
    act(() => onFix(fix(40.7, -74)));
    act(() => onError(error(TIMEOUT)));
    expect(result.current.loc).toMatchObject({ source: "gps", lat: 40.7 });
  });

  it("retries: restarts the watch, reports retrying until the browser answers", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useLocation());
    act(() => vi.advanceTimersByTime(LOCATE_TIMEOUT_MS));
    expect(result.current.loc).toMatchObject({ reason: "waiting" });
    expect(result.current.retrying).toBe(false);

    const watches = geolocation.watchPosition.mock.calls.length;
    act(() => result.current.retry());
    expect(result.current.retrying).toBe(true);
    expect(geolocation.watchPosition.mock.calls.length).toBe(watches + 1);
    expect(geolocation.clearWatch).toHaveBeenCalled();

    act(() => onFix(fix(40.7, -74)));
    expect(result.current.retrying).toBe(false);
    expect(result.current.loc).toMatchObject({ source: "gps", lat: 40.7 });
  });

  it("ends a retry when the browser still refuses, keeping the same demo object", () => {
    const { result } = renderHook(() => useLocation());
    act(() => onError(error(PERMISSION_DENIED)));
    const denied = result.current.loc;
    act(() => result.current.retry());
    expect(result.current.retrying).toBe(true);
    act(() => onError(error(PERMISSION_DENIED)));
    expect(result.current.retrying).toBe(false);
    expect(result.current.loc).toBe(denied);
  });

  it("ends a retry at the fallback timer if the browser never answers", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useLocation());
    act(() => vi.advanceTimersByTime(LOCATE_TIMEOUT_MS));
    act(() => result.current.retry());
    act(() => vi.advanceTimersByTime(LOCATE_TIMEOUT_MS));
    expect(result.current.retrying).toBe(false);
    expect(result.current.loc).toMatchObject({ reason: "waiting" });
  });
});
