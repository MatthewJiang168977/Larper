import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

export const PG = Symbol('PG');

// One pool per API replica. node-postgres rather than an ORM: the queries lean on
// PostGIS and pgvector operators that ORMs don't model well.
export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  const pool = new Pool({
    connectionString,
    max: 10,
    // Fail a request after 5 s instead of queueing it forever while Postgres is down.
    connectionTimeoutMillis: 5_000,
    // No parallel workers for request queries. The candidate query got 3 of them on
    // dense cells: ~4 ms less latency for 2.3x the CPU (loadtest/rank-bench.sh), and
    // under load the requests already keep every core busy. Batch jobs keep them.
    options: '-c max_parallel_workers_per_gather=0',
  });
  // When Postgres goes away, idle pooled clients emit 'error'. Unhandled, that event
  // kills the process, so a database restart took every API replica down with it
  // (loadtest/chaos.sh). The pool already discards the broken client; log and carry on.
  const log = new Logger('Postgres');
  pool.on('error', (err) => log.warn(`idle client error: ${err.message}`));
  return pool;
}

@Global()
@Module({
  providers: [{ provide: PG, useFactory: createPool }],
  exports: [PG],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG) private readonly pool: Pool) {}

  async onApplicationShutdown() {
    await this.pool.end();
  }
}
