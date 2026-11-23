const MINUTE_MS = 60_000;
const RADIANS = Math.PI / 180;
const NYC_LATITUDE = 40.7128 * RADIANS;
const NYC_LONGITUDE = -74.006;

// NOAA's solar calculator equations, based on Jean Meeus's Astronomical Algorithms.
// https://gml.noaa.gov/grad/solcalc/calcdetails.html
function solarPosition(utcMs: number) {
  const daysSinceJ2000 = utcMs / 86_400_000 - 10_957.5;
  const centuries = daysSinceJ2000 / 36_525;
  const meanLongitude = (280.46646 + centuries * (36_000.76983 + centuries * 0.0003032)) % 360;
  const meanAnomaly = (357.52911 + centuries * (35_999.05029 - 0.0001537 * centuries)) * RADIANS;
  const eccentricity = 0.016708634 - centuries * (0.000042037 + 0.0000001267 * centuries);
  const center = Math.sin(meanAnomaly) * (1.914602 - centuries * (0.004817 + 0.000014 * centuries))
    + Math.sin(2 * meanAnomaly) * (0.019993 - 0.000101 * centuries)
    + Math.sin(3 * meanAnomaly) * 0.000289;
  const omega = (125.04 - 1934.136 * centuries) * RADIANS;
  const apparentLongitude = (meanLongitude + center - 0.00569 - 0.00478 * Math.sin(omega)) * RADIANS;
  const meanObliquity = 23 + (26 + (21.448 - centuries * (46.815 + centuries * (0.00059 - 0.001813 * centuries))) / 60) / 60;
  const obliquity = (meanObliquity + 0.00256 * Math.cos(omega)) * RADIANS;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLongitude));

  const y = Math.tan(obliquity / 2) ** 2;
  const longitude = meanLongitude * RADIANS;
  const equationOfTime = 4 / RADIANS * (
    y * Math.sin(2 * longitude) - 2 * eccentricity * Math.sin(meanAnomaly)
    + 4 * eccentricity * y * Math.sin(meanAnomaly) * Math.cos(2 * longitude)
    - 0.5 * y ** 2 * Math.sin(4 * longitude) - 1.25 * eccentricity ** 2 * Math.sin(2 * meanAnomaly)
  );
  return { declination, equationOfTime };
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

/** suncalc-style azimuths run from south, positive towards the west. MapLibre's light wants degrees clockwise from north. */
export function southAzimuthToClockwiseFromNorth(radiansFromSouth: number) {
  return mod(radiansFromSouth / RADIANS + 180, 360);
}

/** The sun over the NYC map center: altitude in degrees above the horizon, azimuth in degrees clockwise from north. */
export function sunPosition(utcMs: number) {
  const { declination, equationOfTime } = solarPosition(utcMs);
  const trueSolarMinutes = mod(utcMs / MINUTE_MS + equationOfTime + 4 * NYC_LONGITUDE, 1440);
  const hourAngle = (trueSolarMinutes / 4 - 180) * RADIANS; // negative before solar noon
  const sinLat = Math.sin(NYC_LATITUDE);
  const cosLat = Math.cos(NYC_LATITUDE);
  const altitude = Math.asin(sinLat * Math.sin(declination) + cosLat * Math.cos(declination) * Math.cos(hourAngle)) / RADIANS;
  const fromSouth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * sinLat - Math.tan(declination) * cosLat,
  );
  return { altitude, azimuth: southAzimuthToClockwiseFromNorth(fromSouth), morning: hourAngle < 0 };
}

export type MapPhase = "dawn" | "day" | "golden" | "dusk" | "night";

/** Which phase the sun's altitude puts the map in. Morning and afternoon differ at the same height. */
export function phaseForSun(altitude: number, morning: boolean): MapPhase {
  if (altitude < -6) return "night";
  if (morning) return altitude < 8 ? "dawn" : "day";
  if (altitude > 12) return "day";
  return altitude > 2 ? "golden" : "dusk";
}

export type MapAppearance = {
  phase: MapPhase;
  /** The phase being blended towards (the same as phase when t is 0). */
  next: MapPhase;
  /** 0 is the phase's exact palette, 1 is the next one's. */
  t: number;
  altitude: number;
  azimuth: number;
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Each phase's palette is exact where the phase begins and eases into the next one's by the
 * altitude where that one begins. Two phases start blending before they end, so no palette
 * jumps: the afternoon day from 20° to 12° (golden hour begins), and the night before dawn
 * from -12° to -6°. Reduced motion pins t to 0: each palette stays exact until its threshold,
 * then is replaced.
 */
export function mapAppearanceAt(now: Date, reducedMotion = false): MapAppearance {
  const { altitude, azimuth, morning } = sunPosition(now.getTime());
  const phase = phaseForSun(altitude, morning);
  let next: MapPhase;
  let t: number;
  switch (phase) {
    case "night": next = "dawn"; t = morning ? (altitude + 12) / 6 : 0; break;
    case "dawn": next = "day"; t = (altitude + 6) / 14; break;
    case "day": next = "golden"; t = morning ? 0 : (20 - altitude) / 8; break;
    case "golden": next = "dusk"; t = (12 - altitude) / 10; break;
    case "dusk": next = "night"; t = (2 - altitude) / 8; break;
  }
  return { phase, next, t: reducedMotion ? 0 : clamp01(t), altitude, azimuth };
}

/** MapLibre light position: radial, azimuthal (clockwise from north), polar (from straight up). */
export function lightPositionFor(altitude: number, azimuth: number): [number, number, number] {
  return [1.4, azimuth, Math.min(80, Math.max(15, 90 - altitude))];
}
