type Point = { x: number; y: number };

// Leave room for the 44px targets, the larger quest pin and the focus rings.
const PIN_SPACING = 56;

export function spreadPins(anchors: Point[]): Point[] {
  const placed: Point[] = [];
  for (const anchor of anchors) {
    // The nearest free point is either the anchor or on the edge of a pin's
    // exclusion square. Intersections account for several pins in a pile.
    const xs = [anchor.x];
    const ys = [anchor.y];
    for (const pin of placed) {
      xs.push(pin.x - PIN_SPACING, pin.x + PIN_SPACING);
      ys.push(pin.y - PIN_SPACING, pin.y + PIN_SPACING);
    }
    let best = anchor;
    let distance = Infinity;
    for (const x of xs) {
      for (const y of ys) {
        const delta = (x - anchor.x) ** 2 + (y - anchor.y) ** 2;
        if (delta >= distance) continue;
        if (placed.some((pin) => Math.abs(x - pin.x) < PIN_SPACING && Math.abs(y - pin.y) < PIN_SPACING)) continue;
        best = { x, y };
        distance = delta;
      }
    }
    placed.push(best);
  }
  return placed;
}
