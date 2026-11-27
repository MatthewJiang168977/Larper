"use client";

// The city behind the signed-out windows: a still of the map for the sun's phase, never a live
// map. The server can't know the visitor's "now" when it prerenders, so the phase is read in
// the browser; until then the page is the day's pink and the day's tint.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { mapAppearanceAt, type MapPhase } from "@/components/map/map-daylight";
import { wallpaperUrl } from "./wallpaper-stills";

/** The design lab pins a phase here (?time=); everywhere else it is null and the sun decides. */
export const PhaseOverride = createContext<MapPhase | null>(null);

/** The sun's phase now, checked each minute; null until the browser has looked. */
export function useMapPhase(): MapPhase | null {
  const pinned = useContext(PhaseOverride);
  const [phase, setPhase] = useState<MapPhase | null>(null);
  useEffect(() => {
    // Stills don't blend: each is exact until the next phase's threshold.
    const look = () => setPhase(mapAppearanceAt(new Date(), true).phase);
    look();
    const timer = setInterval(look, 60_000);
    return () => clearInterval(timer);
  }, []);
  return pinned ?? phase;
}

function Wallpaper({ phase }: { phase: MapPhase | null }) {
  return (
    <div className="larper-auth-wallpaper" aria-hidden="true">
      {phase && (
        <picture>
          <source media="(min-width: 1024px)" srcSet={wallpaperUrl(phase, "desktop")} />
          <img className="larper-auth-wallpaper-still" src={wallpaperUrl(phase, "phone")} alt="" />
        </picture>
      )}
    </div>
  );
}

/** The page: the wallpaper, and `data-phase` for the window's tint (larper-os-auth.css). */
export function AuthRoot({ className, children }: { className: string; children: ReactNode }) {
  const phase = useMapPhase();
  return (
    <main className={className} data-phase={phase ?? undefined}>
      <Wallpaper phase={phase} />
      {children}
    </main>
  );
}
