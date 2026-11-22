import {
  applyStaticGate,
  BLOCKED_CATEGORIES,
  BLOCKED_CATEGORY_GROUPS,
  blockedGroup,
  dedupe,
  DEFAULT_MIN_CONFIDENCE,
  eveningGateFromEnv,
  isBlockedCategory,
  isEveningInNyc,
  meetsConfidence,
  minConfidenceFromEnv,
  normalizeName,
  nycHour,
  passesHoursRule,
  type BlockedGroup,
  type DedupeItem,
} from './eligibility';
import { haversineM } from './geo';

describe('MIN_CONFIDENCE and QUEST_MIN_CONFIDENCE', () => {
  it('defaults to 0.7 and reads the override', () => {
    expect(minConfidenceFromEnv(undefined)).toBe(DEFAULT_MIN_CONFIDENCE);
    expect(minConfidenceFromEnv('')).toBe(DEFAULT_MIN_CONFIDENCE);
    expect(DEFAULT_MIN_CONFIDENCE).toBe(0.7);
    expect(minConfidenceFromEnv('0.85')).toBe(0.85);
    expect(minConfidenceFromEnv('0.5')).toBe(0.5);
    expect(minConfidenceFromEnv('1')).toBe(1);
  });

  it.each(['0.49', '1.01', '-1', 'abc', 'NaN', 'Infinity'])('refuses %s: outside [0.5, 1]', (raw) => {
    expect(() => minConfidenceFromEnv(raw)).toThrow(/QUEST_MIN_CONFIDENCE/);
  });
});

describe('meetsConfidence: the boundary', () => {
  it('passes exactly at the threshold, fails just below, passes just above', () => {
    expect(meetsConfidence(0.7, 0.7)).toBe(true);
    expect(meetsConfidence(0.6999, 0.7)).toBe(false);
    expect(meetsConfidence(0.7001, 0.7)).toBe(true);
    expect(meetsConfidence(Math.fround(0.6999), 0.7)).toBe(false);
    expect(meetsConfidence(Math.fround(0.7001), 0.7)).toBe(true);
  });

  it("passes a float32-rounded 0.7 (what Postgres's real column hands back) at a 0.7 threshold", () => {
    const stored = Math.fround(0.7); // 0.699999988079071
    expect(stored).toBeLessThan(0.7); // a plain >= would refuse the place
    expect(stored >= 0.7).toBe(false);
    expect(meetsConfidence(stored, 0.7)).toBe(true);
  });

  it.each([0.5, 0.55, 0.6, 0.7, 0.75, 0.77, 0.8, 0.85, 0.9, 0.92, 0.95, 1])(
    'a place stored at exactly %s passes a threshold of %s',
    (v) => {
      expect(meetsConfidence(Math.fround(v), v)).toBe(true);
    },
  );

  it('uses the default threshold when none is given', () => {
    expect(meetsConfidence(0.69)).toBe(false);
    expect(meetsConfidence(0.71)).toBe(true);
  });
});

describe('the category blocklist', () => {
  const hierarchies: Record<BlockedGroup, string[][]> = {
    medical: [
      ['health_care', 'outpatient_care_facility', 'dental_clinic'],
      ['health_care', 'hospital'],
      ['shopping', 'specialty_store', 'pharmacy_and_drug_store', 'pharmacy'],
      ['shopping', 'specialty_store', 'pharmacy_and_drug_store', 'drugstore'],
      ['lifestyle_services', 'wellness_service', 'spa', 'medical_spa'],
    ],
    adult: [
      ['arts_and_entertainment', 'nightlife_venue', 'strip_club'],
      ['shopping', 'specialty_store', 'adult_store'],
      ['arts_and_entertainment', 'nightlife_venue', 'adult_entertainment_venue'],
    ],
    worship: [
      ['cultural_and_historic', 'place_of_worship', 'christian_place_of_worship', 'baptist_place_of_worship'],
      ['cultural_and_historic', 'place_of_worship', 'muslim_place_of_worship'],
      ['cultural_and_historic', 'place_of_worship', 'jewish_place_of_worship'],
      ['cultural_and_historic', 'place_of_worship', 'hindu_place_of_worship'],
      ['cultural_and_historic', 'religious_organization', 'monastery'],
    ],
    schools: [
      ['education', 'place_of_learning', 'school'],
      ['education', 'place_of_learning', 'college_university'],
      ['education', 'place_of_learning', 'specialty_school', 'art_school'],
      ['education', 'educational_facility', 'campus_building'],
    ],
    government: [
      ['community_and_government', 'government_office', 'courthouse'],
      ['community_and_government', 'public_safety_service', 'police_station'],
      ['community_and_government', 'military_site'],
    ],
    residential: [
      ['services_and_business', 'real_estate_service', 'real_estate_agent'],
      ['services_and_business', 'housing_or_property_service', 'apartment'],
      ['services_and_business', 'housing_or_property_service', 'condominium'],
      ['services_and_business', 'senior_living_facility', 'retirement_home'],
    ],
    day_care: [
      ['services_and_business', 'family_service', 'child_care_and_day_care', 'day_care_preschool'],
      ['services_and_business', 'family_service', 'child_care_and_day_care'],
      ['preschool'], // cut short: the real one is education > place_of_learning > school > preschool, under `schools`
    ],
    funeral: [
      ['services_and_business', 'family_service', 'funeral_service'],
      ['services_and_business', 'family_service', 'funeral_service', 'cremation_service'],
      ['lifestyle_services', 'animal_or_pet_service', 'pet_cemetery_and_crematorium_service'],
    ],
    // Overture files these under government_office / public_safety_service (blocked as
    // `government`); the names themselves are what is tested here.
    courts_and_jails: [['courthouse'], ['jail_or_prison'], ['jail_or_prison', 'juvenile_detention_center']],
    gambling: [
      ['arts_and_entertainment', 'gaming_venue', 'casino'],
      ['arts_and_entertainment', 'gaming_venue', 'betting_center'],
      ['arts_and_entertainment', 'gaming_venue', 'bingo_hall'],
    ],
    // Hierarchies as they occur in the 2026-09 extract.
    facilities: [
      ['lifestyle_services', 'wellness_service', 'public_bath_house'],
      ['community_and_government', 'public_facility', 'public_restroom'],
      ['travel_and_transportation', 'parking'],
      ['travel_and_transportation', 'vehicle_service', 'automotive_service', 'towing_service'],
      ['travel_and_transportation', 'vehicle_service', 'automotive_service', 'automotive_repair'],
    ],
    restricted_retail: [
      ['shopping', 'food_and_beverage_store', 'tobacco_shop'],
      ['shopping', 'specialty_store', 'smoke_and_vape_store'],
      ['shopping', 'specialty_store', 'smoke_and_vape_store', 'cannabis_dispensary'],
      ['shopping', 'second_hand_store', 'pawn_shop'],
      ['services_and_business', 'legal_service', 'bail_bonds_service'],
    ],
  };

  it('still allows real bathhouses and spas, thrift shops and the rest of their parents', () => {
    expect(isBlockedCategory(['lifestyle_services', 'wellness_service', 'spa'])).toBe(false); // Brooklyn Banya, Russian and Turkish Baths
    expect(isBlockedCategory(['lifestyle_services', 'wellness_service', 'sauna'])).toBe(false);
    expect(isBlockedCategory(['shopping', 'second_hand_store', 'second_hand_clothing_store'])).toBe(false);
    expect(isBlockedCategory(['shopping', 'specialty_store', 'cosmetics_and_fragrance_store'])).toBe(false);
  });

  it.each(Object.entries(hierarchies) as [BlockedGroup, string[][]][])('blocks %s', (group, list) => {
    for (const h of list) {
      expect({ h, blocked: isBlockedCategory(h) }).toEqual({ h, blocked: true });
      expect(blockedGroup(h)).toBe(group);
    }
  });

  it('matches any element of the hierarchy, not just the leaf', () => {
    expect(isBlockedCategory(['health_care', 'some_unknown_leaf'])).toBe(true); // the root
    expect(isBlockedCategory(['x', 'place_of_worship', 'some_unknown_leaf'])).toBe(true); // the middle
    expect(isBlockedCategory(['x', 'y', 'strip_club'])).toBe(true); // the leaf
  });

  it('is case-insensitive', () => {
    expect(isBlockedCategory(['Health_Care'])).toBe(true);
    expect(isBlockedCategory(['SHOPPING', 'ADULT_STORE'])).toBe(true);
    expect(isBlockedCategory(['cultural_and_historic', 'Place_Of_Worship'])).toBe(true);
  });

  it('matches whole names only', () => {
    expect(isBlockedCategory(['education', 'place_of_learning', 'adult_education_center'])).toBe(true); // a school
    expect(isBlockedCategory(['shopping', 'adult_store_supplies'])).toBe(false); // not a substring match
    expect(isBlockedCategory(['x', 'apartment_cleaning'])).toBe(false);
  });

  it.each([
    ['cafe', ['food_and_drink', 'casual_eatery', 'cafe']],
    ['coffee shop', ['food_and_drink', 'non_alcoholic_beverage_venue', 'coffee_shop']],
    ['bookstore', ['shopping', 'specialty_store', 'books_music_and_video_store', 'bookstore']],
    ['park', ['sports_and_recreation', 'park']],
    ['playground', ['sports_and_recreation', 'park', 'playground']],
    ['museum', ['arts_and_entertainment', 'museum', 'art_museum']],
    ['library (under the education root)', ['education', 'library']],
    ['historic site', ['cultural_and_historic', 'historic_site']],
    ['monument', ['cultural_and_historic', 'memorial_site', 'monument']],
    ['public plaza', ['community_and_government', 'public_facility', 'public_plaza']],
    ['community center', ['community_and_government', 'social_or_community_service', 'community_center']],
    ['hostel', ['lodging', 'hostel']],
    ['bed and breakfast', ['lodging', 'bed_and_breakfast']],
    ['inn', ['lodging', 'inn']],
    ['holiday rental home (private lodging)', ['lodging', 'private_lodging', 'holiday_rental_home']],
    ['guest house (private lodging)', ['lodging', 'private_lodging', 'guest_house']],
    ['cemetery', ['cultural_and_historic', 'memorial_site', 'cemetery']],
    ['arcade', ['arts_and_entertainment', 'gaming_venue', 'arcade']],
    ['escape room', ['arts_and_entertainment', 'gaming_venue', 'escape_room']],
    ['lottery vendor (a newsstand that sells tickets)', ['arts_and_entertainment', 'gaming_venue', 'lottery_vendor']],
    // Campus attractions: none of these carries college_university in Overture's hierarchy.
    ['university museum', ['arts_and_entertainment', 'museum']],
    ['university art gallery', ['arts_and_entertainment', 'arts_and_crafts_space', 'art_gallery']],
    ['university library', ['education', 'library']],
    ['university theater', ['arts_and_entertainment', 'performing_arts_venue', 'theater']],
    ['campus park', ['sports_and_recreation', 'park']],
    ['beach', ['geographic_entities', 'land_feature', 'beach']],
    ['no hierarchy', []],
  ])('passes a %s', (_name, h) => {
    expect(isBlockedCategory(h)).toBe(false);
  });

  it('blocks the real hierarchies of day care, funeral homes, courthouses, jails and casinos', () => {
    for (const h of [
      ['education', 'place_of_learning', 'school', 'preschool'],
      ['community_and_government', 'government_office', 'courthouse'],
      ['community_and_government', 'public_safety_service', 'jail_or_prison', 'juvenile_detention_center'],
    ]) {
      expect({ h, blocked: isBlockedCategory(h) }).toEqual({ h, blocked: true });
    }
  });

  it('blocks a place that is itself a college or university, and its schools', () => {
    expect(isBlockedCategory(['education', 'place_of_learning', 'college_university'])).toBe(true);
    expect(isBlockedCategory(['education', 'place_of_learning', 'college_university', 'law_school'])).toBe(true);
  });

  it('keeps private lodging and bed and breakfasts out of the blocklist', () => {
    for (const n of ['private_lodging', 'holiday_rental_home', 'guest_house', 'bed_and_breakfast', 'inn', 'lodging', 'cemetery', 'arcade']) {
      expect(BLOCKED_CATEGORIES).not.toContain(n);
    }
  });

  it('treats a missing hierarchy as nothing to block', () => {
    expect(isBlockedCategory(null)).toBe(false);
    expect(isBlockedCategory(undefined)).toBe(false);
  });

  it('exports one lowercase list, with every name in exactly one group', () => {
    const all = Object.values(BLOCKED_CATEGORY_GROUPS).flat();
    expect(BLOCKED_CATEGORIES).toHaveLength(new Set(all).size);
    expect(all).toHaveLength(new Set(all).size); // no name in two groups
    expect([...BLOCKED_CATEGORIES].sort()).toEqual(all.map((n) => n.toLowerCase()).sort());
    expect(BLOCKED_CATEGORIES.every((n) => n === n.toLowerCase())).toBe(true);
  });

  it('does not block the education root, which libraries sit under', () => {
    expect(BLOCKED_CATEGORIES).not.toContain('education');
    expect(BLOCKED_CATEGORIES).not.toContain('community_and_government');
  });
});

describe('normalizeName', () => {
  it('folds case, punctuation, whitespace, accents and a leading "the"', () => {
    const same = ["Joe's Coffee", 'JOES  COFFEE!', 'The Joes Coffee', '  the   JOE’S coffee ', 'Jöes Cöffee'];
    expect(new Set(same.map(normalizeName))).toEqual(new Set(['joes coffee']));
  });

  it('normalizes the common spellings to one name', () => {
    expect(normalizeName('The Smith & Wollensky')).toBe('smith and wollensky');
    expect(normalizeName('Smith and Wollensky')).toBe('smith and wollensky');
    expect(normalizeName('Café  Mogador')).toBe('cafe mogador');
    expect(normalizeName('Cafe Mogador.')).toBe('cafe mogador');
    expect(normalizeName('Joe’s')).toBe(normalizeName("Joe's"));
    expect(normalizeName('Joe’s')).toBe(normalizeName('Joes'));
  });

  it('drops "the" only at the start, and only as a word', () => {
    expect(normalizeName('Café The Best')).toBe('cafe the best');
    expect(normalizeName('Theodore Tea')).toBe('theodore tea');
    expect(normalizeName('The')).toBe('the'); // nothing left to compare otherwise
  });

  it('keeps non-Latin names apart from each other', () => {
    expect(normalizeName('東京ラーメン')).toBe('東京ラーメン');
    expect(normalizeName('東京ラーメン')).not.toBe(normalizeName('大阪ラーメン'));
  });
});

describe('dedupe', () => {
  const LAT = 40.73;
  const LNG = -73.99;
  const M_PER_DEG_LAT = 111_320;
  // A point this many meters north of the origin.
  const north = (m: number) => ({ lat: LAT + m / M_PER_DEG_LAT, lng: LNG });
  const mk = (id: string, name: string, confidence: number, m = 0): DedupeItem => ({
    id,
    name,
    confidence,
    ...north(m),
  });
  const ids = (xs: DedupeItem[]) => xs.map((x) => x.id).sort();

  it('keeps the higher-confidence one of two same-name places 10 m apart', () => {
    expect(ids(dedupe([mk('1', 'Blue Door Cafe', 0.8), mk('2', 'Blue Door Cafe', 0.95, 10)]))).toEqual(['2']);
    expect(ids(dedupe([mk('2', 'Blue Door Cafe', 0.95, 10), mk('1', 'Blue Door Cafe', 0.8)]))).toEqual(['2']);
  });

  it('keeps both when the same name is 500 m apart', () => {
    expect(ids(dedupe([mk('1', 'Blue Door Cafe', 0.8), mk('2', 'Blue Door Cafe', 0.95, 500)]))).toEqual(['1', '2']);
  });

  it('keeps both when the names differ at the same spot', () => {
    expect(ids(dedupe([mk('1', 'Blue Door Cafe', 0.8), mk('2', 'Red Door Cafe', 0.95)]))).toEqual(['1', '2']);
  });

  it('breaks a confidence tie by the lower id, whichever order they arrive in', () => {
    const a = mk('7', 'Blue Door Cafe', 0.9);
    const b = mk('12', 'Blue Door Cafe', 0.9, 5);
    expect(ids(dedupe([a, b]))).toEqual(['7']);
    expect(ids(dedupe([b, a]))).toEqual(['7']);
    // ids compare as numbers, not as text: 9 < 10
    expect(ids(dedupe([mk('10', 'X Bar', 0.9), mk('9', 'X Bar', 0.9)]))).toEqual(['9']);
  });

  it('treats punctuation, case and a leading "The" as the same name', () => {
    const out = dedupe([mk('1', 'The Blue-Door Café', 0.8), mk('2', 'blue door cafe!', 0.9, 20)]);
    expect(ids(out)).toEqual(['2']);
  });

  it('is the same set of places whatever the input order', () => {
    const items = [
      mk('1', 'Blue Door Cafe', 0.8, 0),
      mk('2', 'Blue Door Cafe', 0.9, 30),
      mk('3', 'Blue Door Cafe', 0.9, 45),
      mk('4', 'Blue Door Cafe', 0.7, 300),
      mk('5', 'Other Place', 0.9, 0),
      mk('6', 'Other Place', 0.9, 10),
    ];
    const expected = ids(dedupe(items));
    expect(expected).toEqual(['2', '4', '5']); // 2 beats 1 (confidence) and 3 (id); 6 loses to 5 (id)
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
    for (let i = 0; i < 50; i++) {
      const shuffled = [...items].sort(() => rnd() - 0.5);
      expect(ids(dedupe(shuffled))).toEqual(expected);
    }
  });

  it('keeps the input order of what it keeps', () => {
    const out = dedupe([mk('3', 'Zed', 0.9), mk('1', 'Alpha', 0.9), mk('2', 'Alpha', 0.5, 5)]);
    expect(out.map((p) => p.id)).toEqual(['3', '1']);
  });

  it('uses 50 m as the limit', () => {
    expect(ids(dedupe([mk('1', 'Same', 0.9), mk('2', 'Same', 0.8, 49)]))).toEqual(['1']);
    expect(ids(dedupe([mk('1', 'Same', 0.9), mk('2', 'Same', 0.8, 51)]))).toEqual(['1', '2']);
  });

  it('never drops places with nothing to compare (empty names)', () => {
    expect(ids(dedupe([mk('1', '', 0.9), mk('2', '!!!', 0.9)]))).toEqual(['1', '2']);
  });

  it('is not quadratic over 3000 candidates', () => {
    const items: DedupeItem[] = Array.from({ length: 3000 }, (_, i) => ({
      id: String(i + 1),
      name: `Place ${i % 1500}`,
      confidence: 0.8 + (i % 7) / 100,
      lat: LAT + (i % 60) * 0.001,
      lng: LNG + Math.floor(i / 60) * 0.001,
    }));
    const t = Date.now();
    const out = dedupe(items);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(out.length).toBeLessThanOrEqual(3000);
    // every pair that is left and shares a name is more than 50 m apart
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (out[i].name === out[j].name) {
          expect(haversineM(out[i].lat, out[i].lng, out[j].lat, out[j].lng)).toBeGreaterThan(50);
        }
      }
    }
  });
});

describe('applyStaticGate', () => {
  const base = { name: 'Place', lat: 40.73, lng: -73.99, categories: ['food_and_drink', 'cafe'] };
  it('applies confidence, categories and dedupe together', () => {
    const out = applyStaticGate(
      [
        { ...base, id: '1', name: 'Good Cafe', confidence: Math.fround(0.7) }, // exactly at the threshold
        { ...base, id: '2', name: 'Shaky Cafe', confidence: Math.fround(0.65) },
        { ...base, id: '3', name: 'City Clinic', confidence: 0.99, categories: ['health_care', 'hospital'] },
        { ...base, id: '4', name: 'Twin Cafe', confidence: 0.8 },
        { ...base, id: '5', name: 'The Twin Cafe', confidence: 0.9 },
      ],
      0.7,
    );
    expect(out.map((p) => p.id)).toEqual(['1', '5']);
  });
});

describe('the evening rule: unknown hours after 6pm in New York', () => {
  const at = (iso: string) => new Date(iso);

  // [label, UTC instant, expected NYC hour, expected in the evening window]
  const cases: [string, string, number, boolean][] = [
    // EST (January): 18:00 local is 23:00Z
    ['EST 17:59:59', '2026-01-15T22:59:59Z', 17, false],
    ['EST 18:00:00', '2026-01-15T23:00:00Z', 18, true],
    ['EST 05:59:59', '2026-01-15T10:59:59Z', 5, true],
    ['EST 06:00:00', '2026-01-15T11:00:00Z', 6, false],
    ['EST midnight', '2026-01-15T05:00:00Z', 0, true],
    ['EST noon', '2026-01-15T17:00:00Z', 12, false],
    // EDT (July): 18:00 local is 22:00Z
    ['EDT 17:59:59', '2026-07-15T21:59:59Z', 17, false],
    ['EDT 18:00:00', '2026-07-15T22:00:00Z', 18, true],
    ['EDT 05:59:59', '2026-07-15T09:59:59Z', 5, true],
    ['EDT 06:00:00', '2026-07-15T10:00:00Z', 6, false],
    ['EDT midnight', '2026-07-15T04:00:00Z', 0, true],
    // The UTC date is not the New York date: 23:30Z in July is 19:30 the same day, 02:00Z is 22:00 the day before
    ['EDT 19:30 (23:30Z)', '2026-07-15T23:30:00Z', 19, true],
    ['EDT 22:00 (02:00Z next day)', '2026-07-16T02:00:00Z', 22, true],
    // Spring forward, 2026-03-08: 02:00 EST becomes 03:00 EDT at 07:00Z
    ['03-08 01:59:59 EST (last second before the jump)', '2026-03-08T06:59:59Z', 1, true],
    ['03-08 03:00:00 EDT (first second after the jump)', '2026-03-08T07:00:00Z', 3, true],
    ['03-08 05:59:59 EDT', '2026-03-08T09:59:59Z', 5, true],
    ['03-08 06:00:00 EDT', '2026-03-08T10:00:00Z', 6, false],
    ['03-08 17:59:59 EDT', '2026-03-08T21:59:59Z', 17, false],
    ['03-08 18:00:00 EDT', '2026-03-08T22:00:00Z', 18, true],
    ['03-07 18:00:00 EST (the day before)', '2026-03-07T23:00:00Z', 18, true],
    ['03-07 17:59:59 EST', '2026-03-07T22:59:59Z', 17, false],
    // Fall back, 2026-11-01: 02:00 EDT becomes 01:00 EST at 06:00Z, so 01:00-01:59 happens twice
    ['11-01 01:30 EDT (first)', '2026-11-01T05:30:00Z', 1, true],
    ['11-01 01:30 EST (second)', '2026-11-01T06:30:00Z', 1, true],
    ['11-01 05:59:59 EST', '2026-11-01T10:59:59Z', 5, true],
    ['11-01 06:00:00 EST', '2026-11-01T11:00:00Z', 6, false],
    ['11-01 17:59:59 EST', '2026-11-01T22:59:59Z', 17, false],
    ['11-01 18:00:00 EST', '2026-11-01T23:00:00Z', 18, true],
    ['10-31 18:00:00 EDT (the day before)', '2026-10-31T22:00:00Z', 18, true],
    ['10-31 17:59:59 EDT', '2026-10-31T21:59:59Z', 17, false],
  ];

  it.each(cases)('%s', (_label, iso, hour, evening) => {
    expect(nycHour(at(iso))).toBe(hour);
    expect(isEveningInNyc(at(iso))).toBe(evening);
  });

  it('with the rule on: unknown hours fail in the evening and pass in the day', () => {
    expect(passesHoursRule(false, at('2026-07-15T22:00:00Z'), true)).toBe(false); // 18:00 EDT
    expect(passesHoursRule(false, at('2026-07-15T09:59:59Z'), true)).toBe(false); // 05:59:59 EDT
    expect(passesHoursRule(false, at('2026-07-15T21:59:59Z'), true)).toBe(true); // 17:59:59 EDT
    expect(passesHoursRule(false, at('2026-07-15T10:00:00Z'), true)).toBe(true); // 06:00 EDT
    expect(passesHoursRule(false, at('2026-01-15T23:00:00Z'), true)).toBe(false); // 18:00 EST
    expect(passesHoursRule(false, at('2026-01-15T22:59:59Z'), true)).toBe(true); // 17:59:59 EST
  });

  it('known hours pass in the evening', () => {
    expect(passesHoursRule(true, at('2026-07-15T22:00:00Z'), true)).toBe(true);
    expect(passesHoursRule(true, at('2026-01-15T05:00:00Z'), true)).toBe(true);
  });

  it('with the rule off, nothing is held back at any hour', () => {
    expect(passesHoursRule(false, at('2026-07-15T22:00:00Z'), false)).toBe(true);
    expect(passesHoursRule(false, at('2026-01-15T05:00:00Z'), false)).toBe(true);
  });

  it('QUEST_GATE_EVENING_UNKNOWN_HOURS: on / off, default off, anything else is an error', () => {
    expect(eveningGateFromEnv(undefined)).toBe(false);
    expect(eveningGateFromEnv('')).toBe(false);
    expect(eveningGateFromEnv('off')).toBe(false);
    expect(eveningGateFromEnv('on')).toBe(true);
    expect(eveningGateFromEnv(' ON ')).toBe(true);
    expect(() => eveningGateFromEnv('true')).toThrow(/QUEST_GATE_EVENING_UNKNOWN_HOURS/);
    expect(() => eveningGateFromEnv('1')).toThrow(/QUEST_GATE_EVENING_UNKNOWN_HOURS/);
  });
});
