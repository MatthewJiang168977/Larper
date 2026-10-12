import ngeohash from 'ngeohash';

const M_PER_DEG_LAT = 111_320;

// Geohash6 cell for a point (~1.2 km x 0.6 km), and the cell's center. Ranking runs
// from the center, so a cached deck is exactly right for everyone in the cell.
export function cellOf(lat: number, lng: number) {
  const cell = ngeohash.encode(lat, lng, 6);
  const { latitude, longitude } = ngeohash.decode(cell);
  return { cell, lat: latitude, lng: longitude };
}

// All geohash cells overlapping a circle's bounding box. Precision 6 (~1.2 km) is
// the "neighbourhood" rarity is measured over; precision 5 (~5 km) is the unit of
// on-demand ingest.
export function cellsCovering(lat: number, lng: number, radiusM: number, precision = 6): string[] {
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLng = radiusM / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  return ngeohash.bboxes(lat - dLat, lng - dLng, lat + dLat, lng + dLng, precision);
}

export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
