// The three focus neighbourhoods. A copy of data/focus-neighborhoods.geojson (approximate
// polygons), because the API's image holds only apps/api; neighborhoods.spec.ts fails if
// the two differ. Rings are [lng, lat].

export interface Neighborhood {
  slug: string;
  name: string;
  ring: readonly (readonly [number, number])[];
}

export const NEIGHBORHOODS: readonly Neighborhood[] = [
  {
    slug: 'east-village',
    name: 'East Village',
    ring: [[-73.9925, 40.7228], [-73.9878, 40.7334], [-73.9745, 40.729], [-73.978, 40.7195], [-73.9925, 40.7228]],
  },
  {
    slug: 'union-square',
    name: 'Union Square',
    ring: [[-73.9945, 40.735], [-73.9925, 40.7385], [-73.985, 40.736], [-73.9885, 40.732], [-73.9945, 40.735]],
  },
  {
    slug: 'greenwich-village',
    name: 'Greenwich Village',
    ring: [[-74.0045, 40.728], [-73.998, 40.7255], [-73.991, 40.735], [-74.001, 40.7385], [-74.0045, 40.728]],
  },
];

export const polygonGeoJson = (n: Neighborhood): string => JSON.stringify({ type: 'Polygon', coordinates: [n.ring] });
