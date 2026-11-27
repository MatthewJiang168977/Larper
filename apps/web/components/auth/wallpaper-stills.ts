// The signed-out wallpaper: one still of the real map per time-of-day phase and screen size,
// exported from the map style by app/design-lab/wallpapers (re-run it when the style changes).
import type { MapPhase } from "@/components/map/map-daylight";

export const WALLPAPER_PHASES: readonly MapPhase[] = ["dawn", "day", "golden", "dusk", "night"];
export const WALLPAPER_SIZES = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
} as const;
export type WallpaperSize = keyof typeof WALLPAPER_SIZES;
export const WALLPAPER_MAX_BYTES = 60_000;

export const wallpaperUrl = (phase: MapPhase, size: WallpaperSize) => `/wallpaper/${phase}-${size}.webp`;
