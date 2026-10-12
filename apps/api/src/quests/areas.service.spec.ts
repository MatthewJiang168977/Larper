import type { Pool } from 'pg';
import type { JobQueue } from '../jobs/job-queue';
import { AreasService, INGEST_QUEUE } from './areas.service';
import { cellsCovering } from './geo';

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
    await expect(svc.survey(LAT, LNG, 1500)).resolves.toEqual({ pending: [], failed: [] });
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
    await expect(svc.survey(LAT, LNG, 1500)).resolves.toEqual({ pending: [], failed: [deadArea] });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
