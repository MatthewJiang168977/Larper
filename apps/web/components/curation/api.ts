// GET /admin/places and POST /admin/places/:id/facts (apps/api/src/curation).

export type Verdict = "great" | "verified" | "closed" | "bad_fit";

export interface CurationFacts {
  verdict: { kind: Verdict; at: string; expired: boolean } | null;
  note: { text: string; at: string } | null;
  hours: { source: string; text: string | null; service: string; at: string; expired: boolean }[];
  reports: { kind: "was_open" | "wasnt_open" | "skipped_closed"; day: string }[];
}

export interface CurationPlace extends CurationFacts {
  id: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  address: string | null;
  website: string | null;
  instagram: string | null;
}

export interface CurationList {
  areas: { slug: string; name: string }[];
  area: string;
  total: number;
  places: CurationPlace[];
}

export type Fact = { kind: Verdict } | { kind: "hours"; hours: string } | { kind: "note"; note: string };

export const MAX_NOTE_LENGTH = 140;
