import {
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { Pool } from 'pg';
import { CacheService } from '../cache/cache.service';
import { PG } from '../db/db.module';
import { isDemoUser } from '../demo/demo-account';
import { isClerkUserId } from './clerk-user-deleter';
import { verifySvix } from './clerk-webhook';
import { PendingClerkDeletions, purgeClerkId } from './pending-clerk-deletions';

export const CLERK_WEBHOOK_SECRET = Symbol('CLERK_WEBHOOK_SECRET');

// POST /webhooks/clerk: Clerk tells Larper a user was deleted in Clerk itself (from the
// profile's "Delete account", or by hand in the dashboard). Without this, that user's
// journal, check-ins, saved places and taste stayed in Larper for good, with no way to
// sign in and delete them (docs/decisions/0005-data-deletion.md, D8).
//
// Off (404) unless CLERK_WEBHOOK_SIGNING_SECRET is set. Every request must carry a valid
// Svix signature; the body is trusted only after that. Only `user.deleted` does anything;
// other event types get a 200 so Clerk doesn't retry them. The per-IP limit applies (it
// is global). Logs name the event type, never the user.
@Controller('webhooks')
export class ClerkWebhookController {
  private readonly log = new Logger('ClerkWebhook');

  constructor(
    @Inject(CLERK_WEBHOOK_SECRET) private readonly secret: Buffer | null,
    @Inject(PG) private readonly pg: Pool,
    private readonly cache: CacheService,
    private readonly pending: PendingClerkDeletions,
  ) {}

  @Post('clerk')
  @HttpCode(200)
  async clerk(
    @Req() req: RawBodyRequest<Request>,
    @Headers('svix-id') id?: string,
    @Headers('svix-timestamp') timestamp?: string,
    @Headers('svix-signature') signature?: string,
  ): Promise<{ ok: true }> {
    if (!this.secret) throw new NotFoundException();
    const body = req.rawBody;
    if (!body || !verifySvix(this.secret, { id, timestamp, signature }, body)) {
      throw new UnauthorizedException({ statusCode: 401, code: 'bad_signature', message: 'invalid webhook signature' });
    }

    let event: { type?: unknown; data?: { id?: unknown } };
    try {
      event = JSON.parse(body.toString('utf8'));
    } catch {
      this.log.warn('Clerk webhook: signed body is not JSON; ignored');
      return { ok: true };
    }
    if (event.type !== 'user.deleted') return { ok: true };

    const clerkId = event.data?.id;
    if (typeof clerkId !== 'string' || !isClerkUserId(clerkId)) {
      this.log.warn('Clerk webhook: user.deleted without a valid user id; ignored');
      return { ok: true };
    }
    // The shared demo account's data belongs to the nightly reset, not to whoever deleted
    // its Clerk user; the reset recreates the Clerk user. Never purge it from here.
    if (isDemoUser(clerkId)) {
      this.log.warn('Clerk webhook: user.deleted for the demo account; ignored');
      return { ok: true };
    }

    // A failure here is a 500: Svix retries with backoff, and both steps are idempotent.
    const purged = await purgeClerkId(this.pg, this.cache, clerkId);
    await this.pending.done(clerkId);
    this.log.log(`Clerk webhook: user.deleted handled (${purged ? 'account deleted' : 'no account'})`);
    return { ok: true };
  }
}
