import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG } from '../db/db.module';

// Producer side of the work queue (consumer: workers/internal/queue). The interface
// mirrors Azure Service Bus "send with a message id for duplicate detection", so the
// cloud deploy can swap in Service Bus without touching callers.
export interface JobQueue {
  /** Enqueues unless a live job with the same key exists. Returns true if it enqueued. */
  enqueue(queue: string, dedupeKey: string, payload: unknown): Promise<boolean>;
}
export const JOB_QUEUE = Symbol('JOB_QUEUE');

@Injectable()
export class PgJobQueue implements JobQueue {
  constructor(@Inject(PG) private readonly pg: Pool) {}

  async enqueue(queue: string, dedupeKey: string, payload: unknown): Promise<boolean> {
    const { rowCount } = await this.pg.query(
      `INSERT INTO jobs (queue, dedupe_key, payload) VALUES ($1, $2, $3)
       ON CONFLICT (queue, dedupe_key) WHERE status IN ('queued', 'running') DO NOTHING`,
      [queue, dedupeKey, JSON.stringify(payload)],
    );
    return (rowCount ?? 0) > 0;
  }
}
