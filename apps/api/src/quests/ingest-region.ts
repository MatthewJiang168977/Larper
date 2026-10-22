import ngeohash from 'ngeohash';

// Where visitors may trigger an area ingest (INGEST_REGION, Helm api.ingestRegion).
// A public demo can't let anyone pull Overture data for the whole planet into a 1-core
// VM: an ingest is a download, about a minute of CPU, and rows that stay in Postgres.
// Outside the region the deck is whatever is already loaded (usually nothing) and the
// web app says the demo covers that region.
//
// "xmin,ymin,xmax,ymax" in degrees (lng, lat, lng, lat), the same order as
// data/extract_overture.py's bbox. Empty: anywhere (local development).

export interface Region {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export function parseRegion(spec: string | undefined): Region | null {
  if (!spec?.trim()) return null;
  const parts = spec.split(',').map((s) => Number(s.trim()));
  const [xmin, ymin, xmax, ymax] = parts;
  const ok =
    parts.length === 4 &&
    parts.every(Number.isFinite) &&
    xmin >= -180 && xmax <= 180 && ymin >= -90 && ymax <= 90 &&
    xmin < xmax && ymin < ymax;
  if (!ok) throw new Error(`INGEST_REGION must be "xmin,ymin,xmax,ymax" in degrees (lng,lat,lng,lat), got "${spec}"`);
  return { xmin, ymin, xmax, ymax };
}

// An area may be ingested if any part of it is in the region: a geohash5 cell (~5 km)
// at the edge still has places inside it.
export function areaInRegion(geohash5: string, region: Region | null): boolean {
  if (!region) return true;
  const [minLat, minLng, maxLat, maxLng] = ngeohash.decode_bbox(geohash5);
  return minLng <= region.xmax && maxLng >= region.xmin && minLat <= region.ymax && maxLat >= region.ymin;
}
