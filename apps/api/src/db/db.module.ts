import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

export const PG = Symbol('PG');

// One pool per API replica. node-postgres rather than an ORM: the queries lean on
// PostGIS and pgvector operators that ORMs don't model well.
@Global()
@Module({
  providers: [
    {
      provide: PG,
      useFactory: () => new Pool({ connectionString: process.env.DATABASE_URL, max: 10 }),
    },
  ],
  exports: [PG],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG) private readonly pool: Pool) {}

  async onApplicationShutdown() {
    await this.pool.end();
  }
}
