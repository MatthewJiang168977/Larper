import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG } from '../db/db.module';
import { JOB_QUEUE, type JobQueue } from '../jobs/job-queue';
import { cellsCovering } from './geo';
import { areaInRegion, parseRegion, type Region } from './ingest-region';

export const INGEST_QUEUE = 'ingest-area';
// A dead-lettered ingest isn't retried on every request; after this long the next
// visitor tries again (Overture or the network may have recovered).
const RETRY_DEAD_AFTER = '1 hour';

export interface Survey {
  /** geohash5 areas being ingested right now; the deck is incomplete until they finish. */
  pending: string[];
  /** Areas whose ingest was dead-lettered recently; served without them. */
  failed: string[];
  /** Areas outside the ingest region (ingest-region.ts): never ingested on request. */
  outside: string[];
}

// Knows which geohash5 areas (~5x5 km) have place data, and asks the ingest-worker
// for the ones around a user that don't.
@Injectable()
export class AreasService {
  private readonly log = new Logger(AreasService.name);
  private readonly region: Region | null;

  constructor(
    @Inject(PG) private readonly pg: Pool,
    @Inject(JOB_QUEUE) private readonly jobs: JobQueue,
  ) {
    // Read once: a malformed INGEST_REGION fails the API at startup, not per request.
    this.region = parseRegion(process.env.INGEST_REGION);
  }

  async survey(lat: number, lng: number, radiusM: number): Promise<Survey> {
    const areas = cellsCovering(lat, lng, radiusM, 5);
    const { rows } = await this.pg.query<{ geohash5: string }>(
      'SELECT geohash5 FROM areas_ingested WHERE geohash5 = ANY($1)',
      [areas],
    );
    const have = new Set(rows.map((r) => r.geohash5));
    const unloaded = areas.filter((a) => !have.has(a));
    const outside = unloaded.filter((a) => !areaInRegion(a, this.region));
    const missing = unloaded.filter((a) => areaInRegion(a, this.region));
    if (!missing.length) return { pending: [], failed: [], outside };

    const dead = await this.pg.query<{ k: string }>(
      `SELECT DISTINCT dedupe_key AS k FROM jobs
       WHERE queue = $1 AND dedupe_key = ANY($2) AND status = 'dead'
         AND updated_at > now() - $3::interval`,
      [INGEST_QUEUE, missing, RETRY_DEAD_AFTER],
    );
    const failed = new Set(dead.rows.map((r) => r.k));
    const pending = missing.filter((a) => !failed.has(a));
    for (const geohash5 of pending) {
      // Deduped by the queue: many users in a new area still enqueue one job per area.
      if (await this.jobs.enqueue(INGEST_QUEUE, geohash5, { geohash5 })) {
        this.log.log(`enqueued ingest for ${geohash5}`);
      }
    }
    return { pending, failed: [...failed], outside };
  }
}
