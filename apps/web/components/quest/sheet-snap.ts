// The quest sheet's two resting heights on a phone: peek (name, distance, category and
// the main action) and full (everything, scrollable, stopping below the notices). Pure,
// so the release rules can be tested without layout or a pointer.

export type Snap = "peek" | "full";

/** A release faster than this (px/s) goes the way it was thrown, wherever it is. */
export const FLICK_PX_S = 500;
/** A handle press that moved less than this is a tap. */
export const TAP_PX = 6;

/**
 * Where the sheet lands when let go. `offset` is how far it sits below full (0 = full,
 * `range` = peek), `velocity` is px/s downward-positive, `moved` is the drag distance.
 */
export function resolveSnap(offset: number, velocity: number, range: number, from: Snap, moved: number): Snap {
  if (Math.abs(moved) < TAP_PX) return from === "peek" ? "full" : "peek"; // a tap toggles
  if (velocity > FLICK_PX_S) return "peek";
  if (velocity < -FLICK_PX_S) return "full";
  return offset > range / 2 ? "peek" : "full";
}

/** How far below full the sheet sits at a snap (its translateY). */
export function offsetFor(snap: Snap, fullH: number, peekH: number) {
  return snap === "full" ? 0 : Math.max(0, fullH - peekH);
}

/**
 * Full height: from the bottom of the screen up to just below the notices (or the
 * header when there are none), so the demo note is never covered. Never shorter than
 * peek.
 */
export function fullHeight(viewportH: number, noticesBottom: number, peekH: number, gap = 8) {
  return Math.max(peekH, Math.round(viewportH - noticesBottom - gap));
}

/** Keys on the handle besides Enter/Space (a button's click toggles): arrows and Home/End. */
export function snapForKey(key: string): Snap | null {
  switch (key) {
    case "ArrowUp":
    case "End":
      return "full";
    case "ArrowDown":
    case "Home":
      return "peek";
    default:
      return null;
  }
}
