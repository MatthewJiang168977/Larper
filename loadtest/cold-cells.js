// Picks the geohash6 cells the cold-cache test (SCENARIO=cold) sends users to:
// cells with at least MIN_PLACES places whose whole default-radius survey area is
// already ingested, so no request starts an ingest job or skips the deck cache.
// For each cell it also lists the other cells that lie entirely within NEAR_M of its
// center: a user who starts there can visit them without their offer going stale
// (offers expire once the user is 5 km from where it was made).
//   node loadtest/cold-cells.js cells.tsv areas.txt > cells.json
// cells.tsv: geohash6, south, west, north, east (from area_totals); areas.txt: one
// ingested geohash5 per line.
// Output: { cells: [[s, w, n, e]], near: [[cell index]] } (near[i] excludes i).
const fs = require('fs');
const path = require('path');
const ngeohash = require(path.join(__dirname, '../apps/api/node_modules/ngeohash'));

const RADIUS_M = 1500; // the API's default radius
const NEAR_M = 4900; // under the API's 5 km OFFER_STALE_METERS
const M_PER_DEG_LAT = 111_320;

const [cellsFile, areasFile] = process.argv.slice(2);
const ingested = new Set(fs.readFileSync(areasFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));

// Same box as cellsCovering() in apps/api/src/quests/geo.ts, at the cell edge so
// any point in the cell is covered.
const covered = (s, w, n, e) => {
  const dLat = RADIUS_M / M_PER_DEG_LAT;
  const dLng = RADIUS_M / (M_PER_DEG_LAT * Math.cos((((s + n) / 2) * Math.PI) / 180));
  return ngeohash.bboxes(s - dLat, w - dLng, n + dLat, e + dLng, 5).every((a) => ingested.has(a));
};

// haversineM from apps/api/src/quests/geo.ts
const haversineM = (lat1, lng1, lat2, lng2) => {
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

const cells = [];
for (const line of fs.readFileSync(cellsFile, 'utf8').split('\n')) {
  const [, ...box] = line.trim().split('\t');
  if (box.length !== 4) continue;
  const [s, w, n, e] = box.map(Number);
  if (covered(s, w, n, e)) cells.push([s, w, n, e]);
}
if (!cells.length) throw new Error('no fully ingested cells');

const near = cells.map(([s, w, n, e], i) => {
  const lat = (s + n) / 2;
  const lng = (w + e) / 2;
  const out = [];
  cells.forEach(([s2, w2, n2, e2], j) => {
    if (j === i) return;
    const corners = [[s2, w2], [s2, e2], [n2, w2], [n2, e2]];
    if (corners.every(([a, b]) => haversineM(lat, lng, a, b) < NEAR_M)) out.push(j);
  });
  return out;
});
console.log(JSON.stringify({ cells, near }));
