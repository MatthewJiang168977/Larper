import { describe, expect, it } from "vitest";
import type { Reasons } from "@/lib/api";
import { whyLines } from "./why-lines";

const none: Reasons = { liked: [], rarest: null, indie: false };
const lines = (category: string, reasons: Partial<Reasons>, name = "Some Place") =>
  whyLines({ name, category }, { ...none, ...reasons });

const INDIE = "Independent. No other locations.";

describe("whyLines: Independent", () => {
  it.each([
    ["sculpture_statue", "a statue"],
    ["street_art", "public art"],
    ["monument", "a monument"],
    ["historic_site", "a historic site"],
    ["park", "a park"],
    ["cemetery", "a cemetery"],
    ["library", "a library"],
    ["landmark_and_historical_building", "a landmark"],
  ])("is left off %s (%s), which isn't a business", (category) => {
    expect(lines(category, { indie: true })).not.toContain(INDIE);
  });

  it.each(["ramen_restaurant", "amusement_park", "beer_garden", "vinyl_record_store"])(
    "shows for a one-off business (%s)",
    (category) => {
      expect(lines(category, { indie: true })).toEqual([INDIE]);
    },
  );

  it("is left off a chain", () => {
    expect(lines("ramen_restaurant", { indie: false })).toEqual([]);
  });

  it.each([
    ["Tasty Hand-Pulled Noodles II", false],
    ["Joe's Pizza III", false],
    ["Ray's #2", false],
    ["Ray's No. 3", false],
    ["Studio 54", true],
    ["Pier 17 Cafe", true],
    ["Cafe Uno", true],
    ["Club X-Ray", true],
  ])("for %s a sequel number in the name hides it: shown=%s", (name, shown) => {
    expect(lines("ramen_restaurant", { indie: true }, name).includes(INDIE)).toBe(shown);
  });
});

describe("whyLines: rarity", () => {
  it.each([
    [1, "The only public art spot around here."],
    [2, "1 of 2 public art spots around here."],
    [5, "1 of 5 public art spots around here."],
  ])("shows %i nearby", (nearby, line) => {
    expect(lines("street_art", { rarest: { tag: "public-art", nearby } })).toEqual([line]);
  });

  it.each([6, 19])("says nothing at %i nearby", (nearby) => {
    expect(lines("street_art", { rarest: { tag: "public-art", nearby } })).toEqual([]);
  });
});

describe("whyLines: You marked", () => {
  it.each([
    // [category, liked, line]
    ["ramen_restaurant", ["ramen"], null], // equal to a word of the category
    ["cafe", ["cafe"], null], // equal to the category
    ["bubble_tea_shop", ["bubble-tea"], null], // contained in the category
    ["ramen_restaurant", ["hand-pulled-noodles", "noodles", "ramen"], "You marked hand pulled noodles."],
    ["chinese_restaurant", ["noodles", "dumplings"], "You marked noodles + dumplings."],
    ["coffee_shop", ["matcha", "hojicha", "ube", "cafe"], "You marked matcha + hojicha + ube."],
    ["cafe", ["cafe", "matcha"], "You marked matcha."],
  ])("at a %s, liked %j reads %s", (category, liked, line) => {
    expect(lines(category, { liked })).toEqual(line ? [line] : []);
  });

  it("writes tags in plain words, never hyphenated", () => {
    expect(lines("bar", { liked: ["listening-bar"], rarest: { tag: "hand_pulled-noodles", nearby: 1 } })).toEqual([
      "You marked listening bar.",
      "The only hand pulled noodles spot around here.",
    ]);
  });
});

describe("whyLines: all together", () => {
  it("drops everything weak from the critique's first quest", () => {
    // The statue: common public art, and not a business.
    expect(lines("sculpture_statue", { liked: [], rarest: { tag: "public-art", nearby: 19 }, indie: true })).toEqual([]);
    // The noodle shop: only the specific tag survives; the "II" hides Independent.
    expect(
      lines(
        "ramen_restaurant",
        { liked: ["hand-pulled-noodles", "noodles", "ramen"], rarest: { tag: "hand-pulled-noodles", nearby: 3 }, indie: true },
        "Tasty Hand-Pulled Noodles II",
      ),
    ).toEqual(["You marked hand pulled noodles.", "1 of 3 hand pulled noodles spots around here."]);
  });

  it("keeps the order: liked, rarity, independent", () => {
    expect(lines("bar", { liked: ["tiki"], rarest: { tag: "tiki", nearby: 1 }, indie: true })).toEqual([
      "You marked tiki.",
      "The only tiki spot around here.",
      INDIE,
    ]);
  });
});
