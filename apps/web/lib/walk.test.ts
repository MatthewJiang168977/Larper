import { describe, expect, it } from "vitest";
import {
  estimateWalk,
  gridWalkM,
  inManhattan,
  OFF_GRID_FACTOR,
  straightLineM,
  walkDistanceM,
  walkLabel,
  walkMinutes,
  type LatLng,
} from "./walk";

const p = (lat: number, lng: number): LatLng => ({ lat, lng });

// Reference walking routes between public NYC landmarks, from the OpenStreetMap foot router
// (routing.openstreetmap.de, fetched 2026-11-23). The router's pace is about 75 m/min, so
// distance is the comparison that matters; minutes are checked at Larper's own 80 m/min.
const MANHATTAN_PAIRS: { name: string; from: LatLng; to: LatLng; routedM: number }[] = [
  { name: "Union Square to the Washington Square arch", from: p(40.7359, -73.9911), to: p(40.7312, -73.9971), routedM: 846 },
  { name: "Grand Central to Times Square", from: p(40.7527, -73.9772), to: p(40.758, -73.9855), routedM: 1056 },
  { name: "Empire State Building to Grand Central", from: p(40.7484, -73.9857), to: p(40.7527, -73.9772), routedM: 1175 },
  { name: "Penn Station to Bryant Park", from: p(40.7506, -73.9935), to: p(40.7536, -73.9832), routedM: 1380 },
  { name: "4th Ave and E 13th St to Warhammer (E 8th St)", from: p(40.7336, -73.9898), to: p(40.73123, -73.99356), routedM: 624 },
  { name: "Columbus Circle to Lincoln Center", from: p(40.7681, -73.9819), to: p(40.7725, -73.9835), routedM: 659 },
];

describe("grid walking distance", () => {
  it.each(MANHATTAN_PAIRS)("is within 20% of a routed walk: $name", ({ from, to, routedM }) => {
    const m = walkDistanceM(from, to);
    expect(m / routedM).toBeGreaterThan(0.8);
    expect(m / routedM).toBeLessThan(1.2);
  });

  it("is closer to the routed walk than the straight line is, on every pair", () => {
    for (const { from, to, routedM } of MANHATTAN_PAIRS) {
      expect(Math.abs(walkDistanceM(from, to) - routedM)).toBeLessThan(Math.abs(straightLineM(from, to) - routedM));
    }
  });

  it("gives minutes close to the routed ones for the Warhammer case", () => {
    const { from, to } = MANHATTAN_PAIRS[4];
    // routed: about 8 min; the card used to say 6 from the straight line
    expect(walkMinutes(walkDistanceM(from, to))).toBeGreaterThanOrEqual(7);
    expect(walkMinutes(walkDistanceM(from, to))).toBeLessThanOrEqual(9);
    expect(walkMinutes(straightLineM(from, to))).toBeLessThan(7);
  });

  it("walks the two legs of a right angle along the rotated grid", () => {
    // 100 m due north along an avenue's bearing (29 degrees) is one leg, no turn.
    const a = p(40.73, -73.99);
    const t = (29 * Math.PI) / 180;
    const dNorth = 100 * Math.cos(t) / 111_195; // degrees of latitude
    const dEast = (100 * Math.sin(t)) / (111_195 * Math.cos((40.73 * Math.PI) / 180));
    const b = p(a.lat + dNorth, a.lng + dEast);
    expect(gridWalkM(a, b)).toBeCloseTo(100, 0);
    // The same 100 m at 45 degrees to the grid is 141 m on foot.
    const c = p(a.lat + (100 * Math.cos(t + Math.PI / 4)) / 111_195, a.lng + (100 * Math.sin(t + Math.PI / 4)) / (111_195 * Math.cos((40.73 * Math.PI) / 180)));
    expect(gridWalkM(a, c)).toBeCloseTo(141.4, 0);
  });

  it("is the same in both directions and zero for the same point", () => {
    const [{ from, to }] = MANHATTAN_PAIRS;
    expect(walkDistanceM(from, to)).toBeCloseTo(walkDistanceM(to, from), 6);
    expect(walkDistanceM(from, from)).toBe(0);
  });
});

describe("outside Manhattan", () => {
  it("uses the straight line times 1.3 in Brooklyn", () => {
    const from = p(40.6738, -73.9708); // Grand Army Plaza
    const to = p(40.6712, -73.9636); // Brooklyn Museum
    expect(inManhattan(from)).toBe(false);
    const m = walkDistanceM(from, to);
    expect(m).toBeCloseTo(straightLineM(from, to) * OFF_GRID_FACTOR, 6);
    // Routed: 1262 m. The factor is a rough guess for streets we know nothing about, and here
    // it runs about 30% short (the route bends round Prospect Park). Directions has the truth.
    expect(m / 1262).toBeGreaterThan(0.6);
    expect(m / 1262).toBeLessThan(1.4);
  });

  it("falls back when only one end is in Manhattan (a walk across a bridge)", () => {
    const manhattan = p(40.7127, -74.0059); // City Hall
    const brooklyn = p(40.6928, -73.9903); // Downtown Brooklyn
    expect(inManhattan(manhattan)).toBe(true);
    expect(inManhattan(brooklyn)).toBe(false);
    expect(walkDistanceM(manhattan, brooklyn)).toBeCloseTo(straightLineM(manhattan, brooklyn) * OFF_GRID_FACTOR, 6);
  });
});

describe("Manhattan outline", () => {
  it.each([
    ["Times Square", 40.758, -73.9855],
    ["Washington Square", 40.7308, -73.9973],
    ["Battery Park", 40.7033, -74.0170],
    ["Columbia University", 40.8075, -73.9626],
    ["The Cloisters", 40.8649, -73.9318],
  ])("includes %s", (_name, lat, lng) => {
    expect(inManhattan(p(lat, lng))).toBe(true);
  });

  it.each([
    ["Downtown Brooklyn", 40.6928, -73.9903],
    ["Williamsburg", 40.7081, -73.9571],
    ["Long Island City", 40.7447, -73.9485],
    ["Hoboken", 40.7440, -74.0324],
    ["Jersey City waterfront", 40.7178, -74.0431],
    ["Chicago", 41.88, -87.63],
  ])("leaves out %s", (_name, lat, lng) => {
    expect(inManhattan(p(lat, lng))).toBe(false);
  });
});

describe("estimateWalk", () => {
  const place = p(40.73123, -73.99356);

  it("works from the current position when there is one", () => {
    const e = estimateWalk(p(40.7336, -73.9898), place, 458);
    expect(e.distanceM).toBe(Math.round(walkDistanceM(p(40.7336, -73.9898), place)));
    expect(e.minutes).toBe(walkMinutes(e.distanceM));
  });

  it("moves when the user moves", () => {
    const far = estimateWalk(p(40.7336, -73.9898), place, 458);
    const near = estimateWalk(p(40.7315, -73.9930), place, 458);
    expect(near.distanceM).toBeLessThan(far.distanceM);
  });

  it("scales the API's straight-line distance when there is no position", () => {
    expect(estimateWalk(null, place, 458).distanceM).toBe(Math.round(458 * OFF_GRID_FACTOR));
    expect(estimateWalk(undefined, place, 458).distanceM).toBe(595);
  });

  it("never says less than a minute", () => {
    expect(estimateWalk(place, place, 0).minutes).toBe(1);
  });

  it("labels the time as an estimate", () => {
    expect(walkLabel({ distanceM: 700, minutes: 9 })).toBe("about 9 min walk, estimated");
  });
});
