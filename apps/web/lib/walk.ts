// Walking distance and time to a place, as an estimate.
//
// The quest card used to divide the straight-line distance by a walking speed. Manhattan's
// streets are a grid rotated about 29 degrees from north, so a straight line cuts through
// buildings: on the street you walk the two legs of a right angle, which is up to 1.4x
// longer. This module estimates the street distance without a routing service. The
// Directions button stays the source of truth for the exact route.

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** Manhattan's avenues run this many degrees east of true north. */
export const GRID_ROTATION_DEG = 29;
/** Outside Manhattan's grid, streets are not on a known angle: straight line times this. */
export const OFF_GRID_FACTOR = 1.3;
/** An easy walking pace, about 4.8 km/h. */
export const WALK_M_PER_MIN = 80;

/**
 * A rough outline of Manhattan island, `[lat, lng]` going round from the southern tip up the
 * Hudson side and back down the East River side. Coarse on purpose: it only decides whether
 * the street grid applies, so it errs a little inside the shoreline and leaves out the
 * other boroughs. Marble Hill and the islands in the rivers are left out.
 */
const MANHATTAN: readonly (readonly [number, number])[] = [
  [40.7005, -74.0170],
  [40.7050, -74.0200],
  [40.7120, -74.0195],
  [40.7200, -74.0175],
  [40.7350, -74.0120],
  [40.7500, -74.0060],
  [40.7700, -73.9960],
  [40.7900, -73.9850],
  [40.8100, -73.9690],
  [40.8400, -73.9490],
  [40.8700, -73.9330],
  [40.8780, -73.9230],
  [40.8730, -73.9130],
  [40.8500, -73.9270],
  [40.8200, -73.9340],
  [40.8000, -73.9330],
  [40.7900, -73.9450],
  [40.7700, -73.9520],
  [40.7500, -73.9660],
  [40.7300, -73.9730],
  [40.7150, -73.9760],
  [40.7080, -73.9790],
  [40.7030, -73.9930],
  [40.7010, -74.0050],
];

function inPolygon(p: LatLng, poly: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [latI, lngI] = poly[i];
    const [latJ, lngJ] = poly[j];
    if (latI > p.lat !== latJ > p.lat && p.lng < ((lngJ - lngI) * (p.lat - latI)) / (latJ - latI) + lngI) {
      inside = !inside;
    }
  }
  return inside;
}

export function inManhattan(p: LatLng): boolean {
  return inPolygon(p, MANHATTAN);
}

/** Great-circle distance in metres. */
export function straightLineM(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Walking distance along Manhattan's street grid: put both points on a plane (metres east
 * and north of `a`), rotate by the grid angle so streets and avenues line up with the axes,
 * and add the two legs.
 */
export function gridWalkM(a: LatLng, b: LatLng): number {
  const dy = (b.lat - a.lat) * RAD * EARTH_RADIUS_M;
  const dx = (b.lng - a.lng) * RAD * EARTH_RADIUS_M * Math.cos(((a.lat + b.lat) / 2) * RAD);
  const t = GRID_ROTATION_DEG * RAD;
  const alongStreets = dx * Math.cos(t) - dy * Math.sin(t);
  const alongAvenues = dx * Math.sin(t) + dy * Math.cos(t);
  return Math.abs(alongStreets) + Math.abs(alongAvenues);
}

/** Estimated walking distance in metres between two points. */
export function walkDistanceM(a: LatLng, b: LatLng): number {
  if (inManhattan(a) && inManhattan(b)) return gridWalkM(a, b);
  return straightLineM(a, b) * OFF_GRID_FACTOR;
}

/** Whole minutes at an easy pace, never less than one. */
export function walkMinutes(distanceM: number): number {
  return Math.max(1, Math.round(distanceM / WALK_M_PER_MIN));
}

export interface WalkEstimate {
  /** Estimated walking distance, whole metres. */
  distanceM: number;
  minutes: number;
}

/**
 * The estimate for a place. With the user's current position it is worked out here, so it
 * moves as they walk. Without one, `fallbackStraightM` (the API's straight-line distance from
 * where it last looked) gets the off-grid factor, since the grid needs both ends.
 */
export function estimateWalk(
  from: LatLng | null | undefined,
  place: LatLng,
  fallbackStraightM: number,
): WalkEstimate {
  const distanceM = Math.round(from ? walkDistanceM(from, place) : fallbackStraightM * OFF_GRID_FACTOR);
  return { distanceM, minutes: walkMinutes(distanceM) };
}

/** "about 9 min walk, estimated": the time is never presented as a routed answer. */
export function walkLabel(e: WalkEstimate): string {
  return `about ${e.minutes} min walk, estimated`;
}
