// The regions Larper covers, with how the map should face in each.
//
// homeBearing: the map's resting bearing there, in degrees clockwise from true north, so
// the street grid reads straight on screen. Manhattan's avenues run about 29° east of
// north, so at 29° they go straight up the screen and the streets straight across. The
// compass still points to real north, and tapping it turns the map north-up.
//
// bbox matches the API's region (Helm api.ingestRegion): [west, south, east, north].
export interface Region {
  id: string;
  bbox: [number, number, number, number];
  homeBearing: number;
}

export const REGIONS: Region[] = [{ id: "nyc", bbox: [-74.26, 40.49, -73.7, 40.92], homeBearing: 29 }];

export function regionAt(lat: number, lng: number): Region | null {
  return REGIONS.find(({ bbox: [w, s, e, n] }) => lng >= w && lng < e && lat >= s && lat < n) ?? null;
}

// Outside every region the map rests north-up.
export function homeBearingAt(lat: number, lng: number): number {
  return regionAt(lat, lng)?.homeBearing ?? 0;
}
