import { beforeEach, describe, expect, it, vi } from "vitest";
import { GOOD_ENOUGH_M, getPreciseFix, PRECISE_FIX_MAX_MS } from "./precise-fix";

let onFix: PositionCallback;
let onError: PositionErrorCallback;
let options: PositionOptions | undefined;
const geolocation = {
  watchPosition: vi.fn((ok: PositionCallback, err: PositionErrorCallback, opts?: PositionOptions) => {
    onFix = ok;
    onError = err;
    options = opts;
    return 7;
  }),
  clearWatch: vi.fn(),
};
const reading = (accuracy: number, lat = 40.73) =>
  ({ coords: { latitude: lat, longitude: -73.99, accuracy } }) as GeolocationPosition;
const error = (code: number) => ({ code, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }) as GeolocationPositionError;

beforeEach(() => {
  vi.useFakeTimers();
  geolocation.clearWatch.mockClear();
  Object.defineProperty(navigator, "geolocation", { value: geolocation, configurable: true });
});

describe("getPreciseFix", () => {
  it("asks for a fresh, high-accuracy reading", () => {
    void getPreciseFix();
    expect(options).toMatchObject({ enableHighAccuracy: true, maximumAge: 0 });
  });

  it("stops early once a reading is good enough", async () => {
    const fix = getPreciseFix();
    onFix(reading(65));
    onFix(reading(GOOD_ENOUGH_M, 40.7301));
    await expect(fix).resolves.toEqual({ lat: 40.7301, lng: -73.99, accuracyM: GOOD_ENOUGH_M });
    expect(geolocation.clearWatch).toHaveBeenCalledWith(7);
  });

  it("keeps the most accurate reading and answers with it at the deadline", async () => {
    const fix = getPreciseFix();
    onFix(reading(300, 40.1));
    onFix(reading(45, 40.2));
    onFix(reading(120, 40.3)); // worse: ignored
    onError(error(3)); // a timeout along the way: keep waiting
    vi.advanceTimersByTime(PRECISE_FIX_MAX_MS);
    await expect(fix).resolves.toMatchObject({ lat: 40.2, accuracyM: 45 });
    expect(geolocation.clearWatch).toHaveBeenCalledWith(7);
  });

  it("answers null at once when location is denied", async () => {
    const fix = getPreciseFix();
    onError(error(1));
    await expect(fix).resolves.toBeNull();
  });

  it("answers null at the deadline when no reading came", async () => {
    const fix = getPreciseFix();
    vi.advanceTimersByTime(PRECISE_FIX_MAX_MS);
    await expect(fix).resolves.toBeNull();
  });
});
