import { readFileSync } from 'fs';
import { join } from 'path';
import { BLOCKED_CATEGORIES, MIN_CONFIDENCE } from '../quests/eligibility';
import { CANDIDATES_SQL } from './candidates.cli';
import { csvField, defaultOutputPath, parseFocusAreas, PilotPlace, rankPilotCandidates, toCsv } from './candidates';

const place = (id: string, over: Partial<PilotPlace> = {}): PilotPlace => ({
  id,
  name: `Place ${id}`,
  lat: 40.73 + Number(id) * 0.001,
  lng: -73.99,
  confidence: 0.9,
  categories: ['food_and_drink', 'restaurant'],
  category: 'restaurant',
  tags: ['ramen'],
  chainLocations: 1,
  website: null,
  phone: null,
  address: null,
  neighborhood: 'East Village',
  ...over,
});

describe('rankPilotCandidates', () => {
  it('applies the trust gate: low confidence, blocked categories and same-name neighbours are out', () => {
    const rows = [
      place('1'),
      place('2', { confidence: 0.5 }),
      place('3', { categories: ['community_and_government', 'place_of_worship'] }),
      place('4', { name: 'Twin', confidence: 0.8 }),
      place('5', { name: 'The Twin', confidence: 0.95, lat: 40.7301, lng: -73.99 }),
    ];
    rows[3].lat = 40.7301;
    const ids = rankPilotCandidates(rows, 10).map((p) => p.id);
    expect(ids).toContain('1');
    expect(ids).not.toContain('2');
    expect(ids).not.toContain('3');
    expect(ids).toContain('5'); // the better-confidence twin stays
    expect(ids).not.toContain('4');
  });

  it('keeps a place exactly at the confidence threshold (float32 comparison, like the API)', () => {
    expect(rankPilotCandidates([place('1', { confidence: MIN_CONFIDENCE })], 5)).toHaveLength(1);
  });

  it('ranks rarer, non-chain, surer places first, and breaks ties on id', () => {
    const rows = [
      place('10', { tags: ['ramen'] }),
      place('11', { tags: ['ramen'] }),
      place('12', { tags: ['ramen'] }),
      place('13', { tags: ['theremin shop'], lat: 40.74 }), // rare tag
      place('14', { tags: ['ramen'], chainLocations: 200, lat: 40.75 }), // chain
      place('15', { tags: ['ramen'], confidence: 0.71, lat: 40.76 }), // less sure
    ];
    const ids = rankPilotCandidates(rows, 10).map((p) => p.id);
    expect(ids[0]).toBe('13');
    expect(ids.indexOf('10')).toBeLessThan(ids.indexOf('15'));
    expect(ids.indexOf('15')).toBeLessThan(ids.indexOf('14'));
    expect(ids.indexOf('10')).toBeLessThan(ids.indexOf('11')); // tie: lower id first
  });

  it('takes at most perArea from each neighborhood', () => {
    const rows = [
      ...[1, 2, 3, 4].map((i) => place(String(i), { neighborhood: 'East Village', lat: 40.73 + i * 0.001 })),
      ...[5, 6].map((i) => place(String(i), { neighborhood: 'Union Square', lat: 40.74 + i * 0.001 })),
    ];
    const out = rankPilotCandidates(rows, 2);
    expect(out.filter((p) => p.neighborhood === 'East Village')).toHaveLength(2);
    expect(out.filter((p) => p.neighborhood === 'Union Square')).toHaveLength(2);
  });
});

describe('CSV', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('x\ny')).toBe('"x\ny"');
    expect(csvField(null)).toBe('');
    expect(csvField('plain')).toBe('plain');
  });

  it('keeps fields a spreadsheet would run as a formula as text', () => {
    expect(csvField('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvField('+1 212 555 0100')).toBe("'+1 212 555 0100");
    expect(csvField('-cafe-')).toBe("'-cafe-");
    expect(csvField('@home')).toBe("'@home");
    expect(csvField('cafe = good')).toBe('cafe = good');
  });

  it('writes the header, leaves the last three columns empty and blanks missing fields', () => {
    const [ranked] = rankPilotCandidates([place('7', { name: 'Joe, "J" & Co', website: 'https://j.example', phone: '+1 212' })], 5);
    const lines = toCsv([ranked]).split('\r\n');
    expect(lines[0]).toBe('place_id,neighborhood,name,address,website,phone,opening_hours,source,date_checked');
    expect(lines[1]).toBe('7,East Village,"Joe, ""J"" & Co",,https://j.example,\'+1 212,,,'); // a leading + would run as a formula
    expect(lines[2]).toBe('');
  });

  it('defaults the output under the gitignored pilot/ folder, dated', () => {
    expect(defaultOutputPath(new Date('2026-11-18T12:00:00Z'))).toBe('pilot/hours-candidates-2026-11-18.csv');
  });
});

describe('focus areas and the query', () => {
  it('reads the committed polygons file: three named polygons', () => {
    const areas = parseFocusAreas(readFileSync(join(__dirname, '../../../../data/focus-neighborhoods.geojson'), 'utf8'));
    expect(areas.map((a) => a.name)).toEqual(['East Village', 'Union Square', 'Greenwich Village']);
    expect(JSON.parse(areas[0].geometry).type).toBe('Polygon');
  });

  it('rejects a file that is not a FeatureCollection of polygons', () => {
    expect(() => parseFocusAreas('{"type":"Point"}')).toThrow();
    expect(() => parseFocusAreas('{"type":"FeatureCollection","features":[{"properties":{"name":"x"},"geometry":{"type":"Point"}}]}')).toThrow();
  });

  it('pins the SQL to the TS rules: same constants, read-only, no writes', () => {
    expect(CANDIDATES_SQL).toContain('p.confidence >= $3::real');
    expect(CANDIDATES_SQL).toContain('lower(c) = ANY($4::text[])');
    expect(CANDIDATES_SQL).toContain('p.location_suspect IS NULL');
    expect(CANDIDATES_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i);
    expect(BLOCKED_CATEGORIES.length).toBeGreaterThan(20);
    const cli = readFileSync(join(__dirname, 'candidates.cli.ts'), 'utf8');
    expect(cli).toContain("'SET TRANSACTION READ ONLY'");
    expect(cli).toMatch(/MIN_CONFIDENCE,\s*BLOCKED_CATEGORIES/);
  });
});
