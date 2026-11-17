// Opening-hours pilot, step 1: which places should the owner look up by hand?
//
// Pure logic (no database, no clock) so it is unit-testable; candidates.cli.ts runs it.
//
// Eligibility is NOT re-implemented: the rows are gated by applyStaticGate() from
// quests/eligibility.ts (confidence, blocked categories, 50 m same-name dedupe), the very
// function the quest ranking runs. The SQL pre-filter in candidates.cli.ts only passes the
// same constants (MIN_CONFIDENCE, BLOCKED_CATEGORIES) to Postgres, as quests.service does.
//
// Ranking is the quest ranking's own score() with no personal taste: weights.taste only
// multiplies "fit", so fit is set to 0 (bestTaste = 0) and what is left is
//   w.rarity * rarity * indie * quality   (distance decay = 1: every place is "at" the pilot)
// i.e. the places the product would most like to send someone to (rare tag around here, not a
// chain, Overture sure it exists). Those are the ones whose hours matter first. Rarity is
// measured over the gated places of the three focus areas, the stand-in for the geohash
// cell stats the API uses.

import { applyStaticGate, GateItem, MIN_CONFIDENCE } from '../quests/eligibility';
import { AreaStats, Candidate, DEFAULT_WEIGHTS, score } from '../quests/scoring';

export interface FocusArea {
  slug: string;
  name: string;
  /** The polygon, as a GeoJSON geometry string, for ST_GeomFromGeoJSON. */
  geometry: string;
}

export interface PilotPlace extends GateItem {
  neighborhood: string; // area name
  category: string;
  tags: string[];
  chainLocations: number;
  website: string | null;
  phone: string | null;
  address: string | null; // the places table has no address column today; always null
  /** Already has hand-verified ('manual') hours: dedupes others, never listed itself. */
  verified?: boolean;
}

export interface RankedPlace extends PilotPlace {
  score: number;
}

/** Reads data/focus-neighborhoods.geojson (a FeatureCollection of Polygons, properties.name). */
export function parseFocusAreas(geojson: string): FocusArea[] {
  const fc = JSON.parse(geojson) as {
    type?: string;
    features?: { properties?: { slug?: string; name?: string }; geometry?: { type?: string } }[];
  };
  if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features) || fc.features.length === 0) {
    throw new Error('focus areas: expected a non-empty GeoJSON FeatureCollection');
  }
  return fc.features.map((f, i) => {
    const name = f.properties?.name;
    if (!name || !f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) {
      throw new Error(`focus areas: feature ${i} needs properties.name and a Polygon geometry`);
    }
    return { slug: f.properties?.slug ?? name, name, geometry: JSON.stringify(f.geometry) };
  });
}

const compareIds = (a: string, b: string) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);

/**
 * The gate, the score, then the top `perArea` of each neighborhood (so one dense area
 * cannot take all the slots), best first overall. Ties break on id, so the output is stable.
 */
export function rankPilotCandidates(rows: readonly PilotPlace[], perArea: number): RankedPlace[] {
  // Dedupe over every place, verified ones included (the API would offer a verified place
  // over its weaker same-name twin), and only then drop those already verified.
  const gated = applyStaticGate(rows, MIN_CONFIDENCE).filter((p) => !p.verified);
  const tagCounts: Record<string, number> = {};
  for (const p of gated) for (const t of new Set(p.tags)) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
  const area: AreaStats = { total: gated.length, tagCounts };

  const scored: RankedPlace[] = gated.map((p) => {
    const c: Candidate = {
      id: p.id,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      category: p.category,
      tags: p.tags,
      taste: 0,
      chainLocations: p.chainLocations,
      confidence: p.confidence,
      distanceM: 0,
      website: p.website,
      instagram: null,
      phone: p.phone,
    };
    return { ...p, score: score(c, area, () => 0, { bestTaste: 0, d0: 1 }, DEFAULT_WEIGHTS).score };
  });
  scored.sort((a, b) => b.score - a.score || compareIds(a.id, b.id));

  const taken = new Map<string, number>();
  const out: RankedPlace[] = [];
  for (const p of scored) {
    const n = taken.get(p.neighborhood) ?? 0;
    if (n >= perArea) continue;
    taken.set(p.neighborhood, n + 1);
    out.push(p);
  }
  return out;
}

// --- CSV ------------------------------------------------------------------------

export const CSV_COLUMNS = [
  'place_id',
  'neighborhood',
  'name',
  'address',
  'website',
  'phone',
  'opening_hours',
  'source',
  'date_checked',
] as const;

// RFC 4180: quote a field holding a comma, quote, CR or LF; double the quotes. A field a
// spreadsheet would run as a formula (starting =, +, -, @, tab or CR: place names and
// websites come from Overture, not from us) gets a leading apostrophe, so it stays text.
export function csvField(v: string | null | undefined): string {
  let s = v ?? '';
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header plus one row per place; the last three columns are left empty for the owner. CRLF, final newline. */
export function toCsv(places: readonly RankedPlace[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const p of places) {
    lines.push([p.id, p.neighborhood, p.name, p.address, p.website, p.phone, '', '', ''].map(csvField).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

export const defaultOutputPath = (now: Date = new Date()) =>
  `pilot/hours-candidates-${now.toISOString().slice(0, 10)}.csv`;
