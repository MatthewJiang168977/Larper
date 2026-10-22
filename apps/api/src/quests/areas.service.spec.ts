import type { Pool } from 'pg';
import type { JobQueue } from '../jobs/job-queue';
import { AreasService, INGEST_QUEUE } from './areas.service';
import { cellsCovering } from './geo';
import { areaInRegion, parseRegion } from './ingest-region';

// Washington Square, 1.5 km: the geohash5 areas the survey will ask about.
const LAT = 40.7308;
const LNG = -73.9973;
const AREAS = cellsCovering(LAT, LNG, 1500, 5);

function fakes(ingested: string[], dead: string[] = []) {
  const query = jest.fn(async (sql: string) =>
    sql.includes('areas_ingested')
      ? { rows: ingested.map((geohash5) => ({ geohash5 })) }
      : { rows: dead.map((k) => ({ k })) },
  );
  const enqueue = jest.fn(async () => true);
  const svc = new AreasService({ query } as unknown as Pool, { enqueue } as JobQueue);
  return { svc, query, enqueue };
}

describe('AreasService.survey', () => {
  it('covers a 1.5 km radius with more than one geohash5 area', () => {
    expect(AREAS.length).toBeGreaterThan(1);
  });

  it('does nothing when every area is ingested', async () => {
    const { svc, enqueue } = fakes(AREAS);
    await expect(svc.survey(LAT, LNG, 1500)).resolves.toEqual({ pending: [], failed: [], outside: [] });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues one deduped job per missing area', async () => {
    const [have, ...missing] = AREAS;
    const { svc, enqueue } = fakes([have]);
    const survey = await svc.survey(LAT, LNG, 1500);
    expect(survey.pending.sort()).toEqual([...missing].sort());
    for (const gh of missing) expect(enqueue).toHaveBeenCalledWith(INGEST_QUEUE, gh, { geohash5: gh });
  });

  it("reports recently dead-lettered areas instead of re-enqueuing them", async () => {
    const [deadArea, ...rest] = AREAS;
    const { svc, enqueue } = fakes(rest, [deadArea]);
    await expect(svc.survey(LAT, LNG, 1500)).resolves.toEqual({ pending: [], failed: [deadArea], outside: [] });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// The public demo's region (values-oci.yaml): the five boroughs, as data/extract_overture.py.
const NYC = '-74.26,40.49,-73.70,40.92';

describe('AreasService.survey with an ingest region', () => {
  const withRegion = (region: string | undefined, ingested: string[] = []) => {
    const before = process.env.INGEST_REGION;
    if (region === undefined) delete process.env.INGEST_REGION;
    else process.env.INGEST_REGION = region;
    try {
      return fakes(ingested);
    } finally {
      if (before === undefined) delete process.env.INGEST_REGION;
      else process.env.INGEST_REGION = before;
    }
  };

  it('ingests inside the region as before', async () => {
    const { svc, enqueue } = withRegion(NYC);
    const survey = await svc.survey(LAT, LNG, 1500); // Washington Square
    expect(survey.outside).toEqual([]);
    expect(survey.pending.sort()).toEqual([...AREAS].sort());
    expect(enqueue).toHaveBeenCalledTimes(AREAS.length);
  });

  it('never enqueues an area outside it, and says which ones it skipped', async () => {
    const { svc, enqueue } = withRegion(NYC);
    const london = cellsCovering(51.5074, -0.1278, 1500, 5);
    await expect(svc.survey(51.5074, -0.1278, 1500)).resolves.toEqual({
      pending: [],
      failed: [],
      outside: london,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('at the edge, ingests the areas that reach into the region and skips the rest', async () => {
    // Just past the region's west edge (Newark, NJ): some covering cells overlap NYC's box.
    const { svc, enqueue } = withRegion(NYC);
    const survey = await svc.survey(40.735, -74.28, 3000);
    expect(survey.pending.length).toBeGreaterThan(0);
    expect(survey.outside.length).toBeGreaterThan(0);
    const region = parseRegion(NYC);
    for (const a of survey.pending) expect(areaInRegion(a, region)).toBe(true);
    for (const a of survey.outside) expect(areaInRegion(a, region)).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(survey.pending.length);
  });

  it('with no region set, ingests anywhere (local development)', async () => {
    const { svc, enqueue } = withRegion(undefined);
    const survey = await svc.survey(51.5074, -0.1278, 1500);
    expect(survey.outside).toEqual([]);
    expect(enqueue).toHaveBeenCalled();
  });

  it('refuses to start with a malformed region', () => {
    expect(() => withRegion('-74.26,40.49,-73.70')).toThrow('INGEST_REGION must be');
    expect(() => withRegion('-73.70,40.49,-74.26,40.92')).toThrow('INGEST_REGION must be'); // west > east
    expect(() => withRegion('a,b,c,d')).toThrow('INGEST_REGION must be');
  });
});
