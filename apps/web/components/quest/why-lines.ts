import type { PlaceView, Reasons } from "@/lib/api";

// "Why this place" claims only what the data supports; a shorter list beats weak
// evidence. The rules run here, at display time, so they also cover quests whose
// reasons were stored before these rules existed (quests.reasons is saved at offer
// time) and need no API change.

export const humanize = (s: string) => s.replaceAll("_", " ").replaceAll("-", " ");

/** A tag shared by more places than this nearby isn't evidence of anything rare. */
export const RARE_MAX_NEARBY = 5;

/** At most this many tags after "You marked". */
const LIKED_MAX = 3;

// Overture categories (the most specific one, as the API sends it) that aren't
// businesses, so "independent" says nothing about them. Explicit names, not word
// patterns: amusement_park and beer_garden are businesses.
const NOT_A_BUSINESS = new Set([
  // public-art, historic, cemetery (taxonomy.yaml)
  "street_art",
  "sculpture_statue",
  "historic_site",
  "monument",
  "fort",
  "lighthouse",
  "historic_mission",
  "cemetery",
  "memorial_park",
  // outside
  "park",
  "dog_park",
  "hiking_trail",
  "national_park",
  "mountain_bike_trail",
  "beach",
  // civic and worship
  "library",
  "buddhist_place_of_worship",
  "hindu_place_of_worship",
  "sikh_place_of_worship",
  // parents a place can stop at when a child category fired its tag
  "landmark_and_historical_building",
  "structure_and_geography",
  "public_plaza",
  "memorial",
  "fountain",
  "bridge",
  "garden",
  "botanical_garden",
  "community_garden",
  "playground",
  "place_of_worship",
  "religious_organization",
  "church_cathedral",
  "mosque",
  "synagogue",
]);

// A name ending in a sequel number ("Tasty Hand-Pulled Noodles II", "Joe's #2",
// "Ray's No. 3") points to a sibling, whatever the chain count says: the count is
// keyed by the normalized name, so "… II" and "…" count as different chains. Only
// II-X and #/No. 2+: bare digits are too often part of the name (Studio 54, Pier 17).
const SEQUEL = /\s(?:II|III|IV|V|VI|VII|VIII|IX|X|(?:#|No\.?\s?)[2-9]\d*)$/;

const words = (s: string) => humanize(s).toLowerCase().split(/\s+/).filter(Boolean);
const within = (inner: string[], outer: string[]) => inner.every((w) => outer.includes(w));

/**
 * The lines under "Why this place", strongest first; empty when nothing holds up.
 */
export function whyLines(place: Pick<PlaceView, "name" | "category">, reasons: Reasons): string[] {
  const lines: string[] = [];
  const category = words(place.category);

  // Drop tags the category already says (ramen at a ramen restaurant), and tags
  // a stronger kept tag already says (noodles after hand pulled noodles).
  const kept: string[][] = [];
  for (const tag of reasons.liked) {
    const w = words(tag);
    if (w.length === 0 || within(w, category) || kept.some((k) => within(w, k))) continue;
    kept.push(w);
    if (kept.length === LIKED_MAX) break;
  }
  if (kept.length > 0) lines.push(`You marked ${kept.map((k) => k.join(" ")).join(" + ")}.`);

  const rarest = reasons.rarest;
  if (rarest && rarest.nearby <= RARE_MAX_NEARBY) {
    const tag = humanize(rarest.tag);
    lines.push(
      rarest.nearby <= 1 ? `The only ${tag} spot around here.` : `1 of ${rarest.nearby} ${tag} spots around here.`,
    );
  }

  if (reasons.indie && !NOT_A_BUSINESS.has(place.category) && !SEQUEL.test(place.name.trim())) {
    lines.push("Independent. No other locations.");
  }
  return lines;
}
