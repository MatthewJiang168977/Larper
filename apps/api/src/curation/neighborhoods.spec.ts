import { readFileSync } from 'fs';
import { join } from 'path';
import { NEIGHBORHOODS } from './neighborhoods';

describe('focus neighbourhoods', () => {
  it('are the polygons of data/focus-neighborhoods.geojson', () => {
    const file = JSON.parse(readFileSync(join(__dirname, '../../../../data/focus-neighborhoods.geojson'), 'utf8')) as {
      features: { properties: { slug: string; name: string }; geometry: { coordinates: number[][][] } }[];
    };
    expect(NEIGHBORHOODS).toEqual(
      file.features.map((f) => ({ slug: f.properties.slug, name: f.properties.name, ring: f.geometry.coordinates[0] })),
    );
  });
});
