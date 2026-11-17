// The trust gate: what may be offered as a quest or a lead at all. Pure functions, so the
// rules are testable without a database; quests.service wires them in (rank() for the
// rules that don't depend on the clock, today() for the one that does).
//
//   a) Overture confidence at least MIN_CONFIDENCE.
//   b) Not in a blocked category (medical, adult, worship, schools, government, residential,
//      day care, funeral, courts and jails, gambling).
//   c) Not a duplicate of a better-confidence place with the same name within 50 m.
//   d) Unknown opening hours are not offered in the evening, New York time (behind a flag).
//
// The gate never revokes a quest the user already has: it decides what gets offered next.

import { haversineM } from './geo';

const DAY_TIME_ZONE = 'America/New_York'; // the same zone quests.service ends "today" in

// --- a) confidence ----------------------------------------------------------------

// Chosen from data/nyc.parquet (566k Overture places, 80k of them in categories the
// taxonomy loads): of the loaded places 9.7% score below 0.7, and they sit on two
// round values (0.55 and 0.65) that are Overture's low-evidence confidences; just above
// them are the 0.75 and 0.77 masses, which are kept. 0.8 would cost 20% of coverage.
export const DEFAULT_MIN_CONFIDENCE = 0.7;
export const MIN_CONFIDENCE_FLOOR = 0.5; // ingest already drops everything below it

// QUEST_MIN_CONFIDENCE overrides it, for tuning without a deploy. Invalid values throw
// at start, like a bad QUEST_WEIGHTS: a silently ignored typo would leave the gate at a
// threshold nobody chose.
export function minConfidenceFromEnv(raw = process.env.QUEST_MIN_CONFIDENCE): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIN_CONFIDENCE;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < MIN_CONFIDENCE_FLOOR || v > 1) {
    throw new Error(`QUEST_MIN_CONFIDENCE must be a number in [${MIN_CONFIDENCE_FLOOR}, 1], got ${JSON.stringify(raw)}`);
  }
  return v;
}

export const MIN_CONFIDENCE = minConfidenceFromEnv();

// places.confidence is a Postgres `real` (float32): 0.7 is stored as 0.699999988..., which
// is below the double 0.7. So both sides are compared as float32, the way Postgres
// compares `confidence >= $n::real` in the candidates query. This is the one place the
// comparison is written in TypeScript. A place exactly at the threshold passes.
export function meetsConfidence(confidence: number, min: number = MIN_CONFIDENCE): boolean {
  return Math.fround(confidence) >= Math.fround(min);
}

// --- b) categories ----------------------------------------------------------------

// Overture taxonomy names (release 2026-09-23.1, as in places.categories: the whole
// hierarchy, root first). A place is blocked when ANY element of its hierarchy is in
// here, so a root or a mid-level name blocks everything below it. They are matched whole
// (never as substrings: "adult_education_center" is not adult content) and case-insensitively.
//
// Not blocked on purpose: the `education` root itself, because libraries live at
// education > library; and community_and_government's parks, plazas, fountains and
// community centers, charities, and cemeteries/memorials (cultural_and_historic).
// Also kept: places visitors stay in. bed_and_breakfast, inn, hostel and the rest of
// `lodging` pass, and so does `private_lodging` (holiday rentals and guest houses, which
// are hosted for visitors, not homes). Attractions on a campus (museums, galleries,
// theaters, libraries) pass too: in the data they never carry college_university in
// their hierarchy, which is only ever education > place_of_learning > college_university
// (> a school of it), so a place that is itself a college stays blocked and its museum doesn't.
export const BLOCKED_CATEGORY_GROUPS = {
  // health_care is the whole tree: hospitals, clinics, dental, pharmacies' care side,
  // mental health, cannabis clinics... A retail pharmacy sits under shopping and is not blocked.
  medical: ['health_care', 'hospital', 'medical_research_institute'],
  // Nightlife and shops that sell sex.
  adult: ['adult_entertainment_venue', 'strip_club', 'adult_store'],
  // Every Overture worship type is a child of place_of_worship; the list is the type and
  // its children as they occur, so a hierarchy cut short still matches.
  worship: [
    'place_of_worship',
    'anglican_or_episcopal_place_of_worship',
    'baptist_place_of_worship',
    'buddhist_place_of_worship',
    'christian_place_of_worship',
    'eastern_orthodox_place_of_worship',
    'greek_orthodox_place_of_worship',
    'hindu_place_of_worship',
    'jehovahs_witness_place_of_worship',
    'jewish_place_of_worship',
    'lutheran_place_of_worship',
    'methodist_place_of_worship',
    'muslim_place_of_worship',
    'pentecostal_place_of_worship',
    'protestant_place_of_worship',
    'restorationist_place_of_worship',
    'roman_catholic_place_of_worship',
    'russian_orthodox_place_of_worship',
    'sikh_place_of_worship',
    'religious_organization',
    'monastery',
    'seminary',
  ],
  // place_of_learning is every school, college, art/music/driving school and adult
  // education center; the others are campus buildings, tutoring and the education offices.
  schools: [
    'place_of_learning',
    'school',
    'specialty_school',
    'college_university',
    'religious_school',
    'educational_facility',
    'educational_service',
    'education_office',
  ],
  // Offices and utilities of the state: not parks, plazas or community centers.
  government: ['government_office', 'public_safety_service', 'military_site', 'public_utility'],
  // Homes, and the businesses that sell or manage them.
  residential: [
    'real_estate_service',
    'housing_or_property_service',
    'apartment',
    'condominium',
    'housing_cooperative',
    'mobile_home_park',
    'low_income_housing',
    'university_housing',
    'senior_living_facility',
    'retirement_home',
    'assisted_living_facility',
    'service_apartment',
    'housing_authority',
    'homeless_shelter',
  ],
  // Children's day care, child care and preschools (services_and_business > family_service >
  // child_care_and_day_care > day_care_preschool; preschool is education > ... > school >
  // preschool, already under `schools`, and is listed here too so a cut-short hierarchy matches).
  day_care: ['child_care_and_day_care', 'day_care_preschool', 'preschool'],
  // Funeral homes, funeral services, mortuaries and crematoria (funeral_service is the parent
  // of cremation_service in Overture, which has no separate mortuary type). Cemeteries are NOT
  // here: cultural_and_historic > memorial_site > cemetery stays allowed. A pet crematorium is
  // a crematorium, and its parent name says cemetery too, so it is listed by its whole name.
  funeral: ['funeral_service', 'cremation_service', 'pet_cemetery_and_crematorium_service'],
  // Courthouses, jails and prisons. Overture files all of them under government_office and
  // public_safety_service, which the `government` group already blocks; these names keep
  // them blocked if the hierarchy is ever cut short or the parents change.
  courts_and_jails: ['courthouse', 'jail_or_prison', 'juvenile_detention_center'],
  // Gambling venues: casinos, betting centers (sportsbooks) and bingo halls. Not the whole
  // arts_and_entertainment > gaming_venue parent, which also holds arcades and escape rooms,
  // and not lottery_vendor, which is mostly newsstands and candy shops that sell tickets.
  gambling: ['casino', 'betting_center', 'bingo_hall'],
} as const;

export type BlockedGroup = keyof typeof BLOCKED_CATEGORY_GROUPS;

const BLOCKED_BY_NAME = new Map<string, BlockedGroup>(
  (Object.entries(BLOCKED_CATEGORY_GROUPS) as [BlockedGroup, readonly string[]][]).flatMap(([group, names]) =>
    names.map((n) => [n.toLowerCase(), group] as const),
  ),
);

/** The same names, lowercase: the one list the candidates query is given (no second copy to drift). */
export const BLOCKED_CATEGORIES: readonly string[] = [...BLOCKED_BY_NAME.keys()];

/** The group that blocks this hierarchy, or null if nothing in it is blocked. */
export function blockedGroup(categories: readonly string[] | null | undefined): BlockedGroup | null {
  for (const c of categories ?? []) {
    const g = BLOCKED_BY_NAME.get(c.toLowerCase());
    if (g) return g;
  }
  return null;
}

export const isBlockedCategory = (categories: readonly string[] | null | undefined) => blockedGroup(categories) !== null;

// --- c) duplicates ----------------------------------------------------------------

export const DUPLICATE_RADIUS_M = 50;

/**
 * "Same name" for dedupe: Unicode-normalized (accents folded), lowercase, "&" read as
 * "and", apostrophes dropped, other punctuation and runs of whitespace collapsed to one
 * space, a leading "the " dropped. "The Joe's Coffee" and "joes  coffee!" are one name.
 */
export function normalizeName(name: string): string {
  let s = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['‘’ʼ`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (s.startsWith('the ')) s = s.slice(4).trim();
  return s;
}

// Ids are bigints in text form: shorter is smaller, same length compares as text.
const compareIds = (a: string, b: string) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);

export interface DedupeItem {
  id: string;
  name: string;
  lat: number;
  lng: number;
  confidence: number;
}

/**
 * Drops near-identical places: the same normalized name within 50 m. Of each cluster the
 * one with the higher confidence stays, a tie goes to the lower id, so the answer doesn't
 * depend on the order of the input. Grouped by name first, so the distance checks are only
 * among places that share one (no pass over all pairs). Keeps the input's order.
 */
export function dedupe<T extends DedupeItem>(items: readonly T[], radiusM = DUPLICATE_RADIUS_M): T[] {
  const byName = new Map<string, T[]>();
  for (const p of items) {
    const key = normalizeName(p.name);
    if (key === '') continue; // nothing to compare: kept below
    const group = byName.get(key);
    if (group) group.push(p);
    else byName.set(key, [p]);
  }
  const dropped = new Set<T>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const best = [...group].sort((a, b) => b.confidence - a.confidence || compareIds(a.id, b.id));
    const kept: T[] = [];
    for (const p of best) {
      if (kept.some((k) => haversineM(k.lat, k.lng, p.lat, p.lng) <= radiusM)) dropped.add(p);
      else kept.push(p);
    }
  }
  return items.filter((p) => !dropped.has(p));
}

// --- the static rules together ----------------------------------------------------

export interface GateItem extends DedupeItem {
  categories: readonly string[];
}

/** a), b), then c): what rank() runs on the candidates before scoring them. */
export function applyStaticGate<T extends GateItem>(items: readonly T[], minConfidence: number = MIN_CONFIDENCE): T[] {
  return dedupe(items.filter((p) => meetsConfidence(p.confidence, minConfidence) && !isBlockedCategory(p.categories)));
}

// --- d) unknown hours in the evening ----------------------------------------------

// New York local time: from 18:00 (inclusive) to 06:00 (exclusive).
export const EVENING_START_HOUR = 18;
export const EVENING_END_HOUR = 6;

const hourFormat = new Intl.DateTimeFormat('en-US', { timeZone: DAY_TIME_ZONE, hour: 'numeric', hourCycle: 'h23' });

/** The hour (0-23) it is in New York at this instant, DST included. */
export function nycHour(now: Date): number {
  const h = hourFormat.formatToParts(now).find((p) => p.type === 'hour')?.value;
  return Number(h) % 24; // 'h23' never says 24; the modulo is a guard for engines that do
}

export function isEveningInNyc(now: Date): boolean {
  const h = nycHour(now);
  return h >= EVENING_START_HOUR || h < EVENING_END_HOUR;
}

export interface GateConfig {
  minConfidence: number;
  // QUEST_GATE_EVENING_UNKNOWN_HOURS=on: in the evening nothing with unknown hours is offered.
  eveningUnknownHours: boolean;
}

// "on" or "off", parsed here and nowhere else. Off by default: places have no opening
// hours yet, so turning it on today means no new quest after 6pm. A typo throws.
export function eveningGateFromEnv(raw = process.env.QUEST_GATE_EVENING_UNKNOWN_HOURS): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'off') return false;
  if (v === 'on') return true;
  throw new Error(`QUEST_GATE_EVENING_UNKNOWN_HOURS must be "on" or "off", got ${JSON.stringify(raw)}`);
}

export const gateConfigFromEnv = (): GateConfig => ({
  minConfidence: minConfidenceFromEnv(),
  eveningUnknownHours: eveningGateFromEnv(),
});

/** Whether the evening rule lets a place with these hours be offered at this instant. */
export function passesHoursRule(hoursKnown: boolean, now: Date, enabled: boolean): boolean {
  return !enabled || hoursKnown || !isEveningInNyc(now);
}
