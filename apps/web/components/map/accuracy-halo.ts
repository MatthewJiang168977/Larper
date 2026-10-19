// The "you are here" halo is the reading's accuracy radius drawn to scale, so a rough
// fix looks rough. Clamped at both ends: never hidden under the 22 px dot, and never
// so wide (a 2 km wifi guess) that it washes out the whole screen.
export const HALO_MIN_PX = 34;
export const HALO_MAX_PX = 480;

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
// MapLibre's zoom levels are defined on 512 px tiles.
const TILE_PX = 512;

/** Ground meters covered by one CSS pixel at this latitude and zoom. */
export function metersPerPixel(lat: number, zoom: number) {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (TILE_PX * 2 ** zoom);
}

/** Halo diameter in pixels for an accuracy radius in meters, or null when there's none to show. */
export function haloDiameterPx(accuracyM: number | undefined, lat: number, zoom: number): number | null {
  if (accuracyM === undefined || !Number.isFinite(accuracyM) || accuracyM <= 0) return null;
  const px = (2 * accuracyM) / metersPerPixel(lat, zoom);
  return Math.round(Math.min(HALO_MAX_PX, Math.max(HALO_MIN_PX, px)));
}
