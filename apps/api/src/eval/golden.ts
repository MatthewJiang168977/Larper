import { csvField } from '../hours-pilot/candidates';
import type { Verdict } from '../curation/place-facts';

// data/golden-places.csv: the curator's ratings, one row per place, written from the curation
// actions (ops/golden-export) and read by the offline eval.

export const GOLDEN_COLUMNS = ['overture_id', 'rating', 'note', 'rated_at'] as const;
export const RATINGS = ['great', 'fine', 'bad', 'closed'] as const;
export type Rating = (typeof RATINGS)[number];

export const RATING_OF: Record<Verdict, Rating> = { great: 'great', verified: 'fine', bad_fit: 'bad', closed: 'closed' };

export interface GoldenRow {
  overtureId: string;
  rating: Rating;
  note: string;
  /** A date, no time: the file is public. */
  ratedAt: string;
}

export function toGoldenCsv(rows: readonly GoldenRow[]): string {
  const lines = [GOLDEN_COLUMNS.join(',')];
  for (const r of [...rows].sort((a, b) => (a.overtureId < b.overtureId ? -1 : 1))) {
    lines.push([r.overtureId, r.rating, r.note, r.ratedAt].map(csvField).join(','));
  }
  return lines.join('\n') + '\n';
}

// RFC 4180 fields: quoted ones may hold commas, newlines and doubled quotes.
function records(csv: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const text = csv.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') field += text[++i];
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '
') {
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    out.push(row);
  }
  return out;
}

/** The ratings by overture id. A malformed file throws: a half-read golden set would mislead. */
export function parseGoldenCsv(csv: string): Map<string, Rating> {
  const [head, ...rows] = records(csv);
  if (head?.join(',') !== GOLDEN_COLUMNS.join(',')) throw new Error(`golden set: the header must be ${GOLDEN_COLUMNS.join(',')}`);
  const out = new Map<string, Rating>();
  for (const [i, r] of rows.entries()) {
    if (r.length === 1 && !r[0]) continue;
    const [id, rating] = r;
    if (r.length !== 4 || !id || !(RATINGS as readonly string[]).includes(rating)) {
      throw new Error(`golden set: row ${i + 2} is not overture_id,rating(${RATINGS.join('|')}),note,rated_at`);
    }
    if (out.has(id)) throw new Error(`golden set: ${id} appears twice`);
    out.set(id, rating as Rating);
  }
  return out;
}
