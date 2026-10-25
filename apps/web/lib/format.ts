// "120 m", "2.8 km", "306 km": metres near the door, kilometres for the long misses, as
// the API writes them (apps/api/src/quests/checkin.ts formatDistance).
export function formatDistance(m: number) {
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 100_000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}
