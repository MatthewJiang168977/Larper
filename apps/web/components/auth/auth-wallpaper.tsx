"use client";

// The city behind the signed-out windows: a still of the map for the sun's phase, never a live
// map. The pins and the flag on it are decoration. The server can't know the visitor's "now"
// when it prerenders, so the still is picked in the browser, over the pink of the page.
import { useEffect, useState } from "react";
import { PixelArt } from "@/components/larper-os/pixel-art";
import { mapAppearanceAt, type MapPhase } from "@/components/map/map-daylight";
import { wallpaperUrl } from "./wallpaper-stills";

// [x, y] from the design's 390×844 and 1440×900 boards, kept centred.
const PINS = {
  phone: { width: 390, flag: [142, 316], icons: [[122, 260], [255, 391], [64, 468], [232, 516], [29, 346], [279, 245]] },
  desktop: {
    width: 1440,
    flag: [532, 386],
    icons: [[512, 330], [645, 461], [454, 538], [622, 586], [419, 416], [669, 315], [627, 680], [370, 606], [518, 711]],
  },
} as const;

const at = (width: number, [x, y]: readonly [number, number]) => ({ left: `calc(50% + ${x - width / 2}px)`, top: y });

/** The sun's phase now, checked each minute; null until the browser has looked. */
export function useMapPhase(): MapPhase | null {
  const [phase, setPhase] = useState<MapPhase | null>(null);
  useEffect(() => {
    // Stills don't blend: each is exact until the next phase's threshold.
    const look = () => setPhase(mapAppearanceAt(new Date(), true).phase);
    look();
    const timer = setInterval(look, 60_000);
    return () => clearInterval(timer);
  }, []);
  return phase;
}

export function AuthWallpaper() {
  const phase = useMapPhase();
  return (
    <div className="larper-auth-wallpaper" data-phase={phase ?? undefined} aria-hidden="true">
      {phase && (
        <picture>
          <source media="(min-width: 1024px)" srcSet={wallpaperUrl(phase, "desktop")} />
          <img className="larper-auth-wallpaper-still" src={wallpaperUrl(phase, "phone")} alt="" />
        </picture>
      )}
      {(["phone", "desktop"] as const).map((size) => (
        <div key={size} className={`larper-auth-pins-${size}`}>
          {PINS[size].icons.map((xy, i) => (
            <span key={i} className="larper-auth-pin" style={at(PINS[size].width, xy)}>{i + 1}</span>
          ))}
          <span className="larper-auth-pin larper-auth-flag" style={at(PINS[size].width, PINS[size].flag)}>
            <PixelArt name="flag" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** The mini map beside the form on a wide screen: a crop of the same still around a neighbourhood label. */
export function AuthMiniMap() {
  const phase = useMapPhase();
  return (
    <div className="larper-auth-minimap" data-phase={phase ?? undefined} aria-hidden="true">
      {phase && (
        // A background, so a phone (where the pane is hidden) never downloads it.
        <div className="larper-auth-minimap-still" style={{ backgroundImage: `url(${wallpaperUrl(phase, "desktop")})` }} />
      )}
      <span className="larper-auth-pin larper-auth-flag larper-auth-minimap-flag">
        <PixelArt name="flag" />
      </span>
    </div>
  );
}
