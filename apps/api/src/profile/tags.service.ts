import { Inject, Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG } from '../db/db.module';
import { VIBE_CARDS } from './cards';

export const TAG_DIMS = 160; // must match vector(160) in db/migrations

// Slot <-> tag mapping, published to the tags table by load-places. Loaded once per
// replica: the taxonomy only changes with a new loader run and a rollout.
@Injectable()
export class TagsService implements OnModuleInit {
  private readonly log = new Logger(TagsService.name);
  private bySlot = new Map<number, string>();
  private byTag = new Map<string, number>();

  constructor(@Inject(PG) private readonly pg: Pool) {}

  async onModuleInit() {
    try {
      await this.reload();
    } catch (err) {
      // Don't crash the pod over this; onboarding will 503 until tags exist.
      this.log.warn(`could not load tags: ${(err as Error).message}`);
    }
  }

  async reload() {
    const { rows } = await this.pg.query<{ slot: number; tag: string }>('SELECT slot, tag FROM tags');
    this.bySlot = new Map(rows.map((r) => [r.slot, r.tag]));
    this.byTag = new Map(rows.map((r) => [r.tag, r.slot]));
    const missing = VIBE_CARDS.flatMap((c) => c.tags).filter((t) => !this.byTag.has(t));
    if (rows.length && missing.length) this.log.error(`vibe cards use unknown tags: ${missing.join(', ')}`);
    this.log.log(`loaded ${rows.length} tags`);
  }

  async ready() {
    if (this.byTag.size === 0) await this.reload();
    if (this.byTag.size === 0) throw new ServiceUnavailableException('taxonomy not loaded yet (run load-places)');
  }

  slotOf = (tag: string) => this.byTag.get(tag);
  tagOf = (slot: number) => this.bySlot.get(slot);
}
