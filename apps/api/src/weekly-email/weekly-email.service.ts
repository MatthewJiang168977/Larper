import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuthUser } from '../auth/auth.guard';
import { PG } from '../db/db.module';
import { clerkApi } from '../demo/clerk-api';
import { isDemoUser } from '../demo/demo-account';
import { deliveryDay, resendProvider, unsubscribeToken, verifiedRecipient, verifiedUnsubscribeId, weeklyMail, type MailProvider } from './mail';

export const WEEKLY_EMAIL = Symbol('WEEKLY_EMAIL');

type Delivery = {
  appOrigin: string;
  apiOrigin: string;
  postalAddress: string;
  recipient: (clerkId: string) => Promise<{ id: string; address: string } | null>;
  send: MailProvider;
};
export type WeeklyEmailConfig = { key: Buffer | null; delivery: Delivery | null };

export function weeklyEmailFromEnv(env: NodeJS.ProcessEnv): WeeklyEmailConfig {
  const secret = env.WEEKLY_EMAIL_UNSUBSCRIBE_KEY?.trim();
  if (secret && !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('WEEKLY_EMAIL_UNSUBSCRIBE_KEY must encode 32 random bytes');
  const key = secret ? Buffer.from(secret, 'base64url') : null;
  if (env.WEEKLY_EMAIL_ENABLED !== '1') return { key, delivery: null };
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required with WEEKLY_EMAIL_ENABLED=1`);
    return value;
  };
  const origin = (name: string) => {
    const value = new URL(required(name));
    if (value.protocol !== 'https:' || value.href !== `${value.origin}/`) throw new Error(`${name} must be an HTTPS origin`);
    return value.origin;
  };
  if (!key) throw new Error('WEEKLY_EMAIL_UNSUBSCRIBE_KEY is required with WEEKLY_EMAIL_ENABLED=1');
  const clerk = clerkApi(required('CLERK_SECRET_KEY'));
  return { key, delivery: {
    appOrigin: origin('WEEKLY_EMAIL_APP_ORIGIN'),
    apiOrigin: origin('WEEKLY_EMAIL_API_ORIGIN'),
    postalAddress: required('WEEKLY_EMAIL_POSTAL_ADDRESS'),
    recipient: (id) => verifiedRecipient(clerk, id),
    send: resendProvider(required('WEEKLY_EMAIL_RESEND_KEY'), required('WEEKLY_EMAIL_FROM')),
  } };
}

type Claim = { user_id: string; clerk_id: string; email_address_id: string; unsubscribe_id: string; saved: number };

const CLAIM_SQL = `WITH next AS (
  SELECT p.user_id, u.clerk_id FROM weekly_email_preferences p JOIN users u ON u.id = p.user_id
  WHERE p.opted_in_at IS NOT NULL AND u.clerk_id <> $2
    AND (p.last_attempt_day IS NULL OR p.last_attempt_day < $1::date)
  ORDER BY p.user_id LIMIT 1 FOR UPDATE OF p SKIP LOCKED
)
UPDATE weekly_email_preferences p SET last_attempt_day = $1::date FROM next
WHERE p.user_id = next.user_id
RETURNING p.user_id::text, next.clerk_id, p.email_address_id, p.unsubscribe_id,
  (SELECT count(*)::int FROM saved_places s WHERE s.user_id = p.user_id) AS saved`;

@Injectable()
export class WeeklyEmailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WeeklyEmailService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(@Inject(PG) private readonly db: Pool, @Inject(WEEKLY_EMAIL) private readonly config: WeeklyEmailConfig) {}

  onModuleInit() {
    if (!this.config.delivery) return;
    const run = () => void this.runDue().catch(() => this.logger.warn('Weekly email scheduling failed'));
    this.timer = setInterval(run, 5 * 60_000);
    this.timer.unref();
    run();
  }

  onModuleDestroy() { clearInterval(this.timer); }

  private enabled(user: AuthUser): Delivery {
    if (!this.config.delivery) throw new NotFoundException();
    if (isDemoUser(user.clerkId)) throw new ForbiddenException({ code: 'demo_account' });
    return this.config.delivery;
  }

  async preference(user: AuthUser) {
    this.enabled(user);
    const { rows } = await this.db.query<{ enabled: boolean }>(
      'SELECT opted_in_at IS NOT NULL AS enabled FROM weekly_email_preferences WHERE user_id = $1', [user.id],
    );
    return { enabled: rows[0]?.enabled ?? false };
  }

  async setPreference(user: AuthUser, enabled: unknown) {
    const delivery = this.enabled(user);
    if (typeof enabled !== 'boolean') throw new BadRequestException('Choose whether to receive the weekly email.');
    if (!enabled) {
      await this.db.query(
        'UPDATE weekly_email_preferences SET opted_in_at = NULL, email_address_id = NULL, unsubscribe_id = NULL WHERE user_id = $1',
        [user.id],
      );
      return { enabled: false };
    }
    const recipient = await delivery.recipient(user.clerkId).catch(() => {
      throw new ServiceUnavailableException('Could not check your email address. Try again.');
    });
    if (!recipient) throw new BadRequestException('Verify your primary email address before subscribing.');
    await this.db.query(`INSERT INTO weekly_email_preferences (user_id, opted_in_at, email_address_id, unsubscribe_id)
      VALUES ($1, now(), $2, $3)
      ON CONFLICT (user_id) DO UPDATE SET opted_in_at = excluded.opted_in_at,
        email_address_id = excluded.email_address_id, unsubscribe_id = excluded.unsubscribe_id
      WHERE weekly_email_preferences.email_address_id IS DISTINCT FROM excluded.email_address_id`,
    [user.id, recipient.id, randomUUID()]);
    return { enabled: true };
  }

  checkUnsubscribe(token: unknown) {
    const id = this.config.key && verifiedUnsubscribeId(token, this.config.key);
    if (!id) throw new NotFoundException();
    return id;
  }

  async unsubscribe(token: unknown) {
    const id = this.checkUnsubscribe(token);
    await this.db.query(`UPDATE weekly_email_preferences
      SET opted_in_at = NULL, email_address_id = NULL, unsubscribe_id = NULL WHERE unsubscribe_id = $1`, [id]);
  }

  async runDue(now = new Date()) {
    const { delivery, key } = this.config;
    const day = deliveryDay(now);
    if (!delivery || !key || !day || this.running) return;
    this.running = true;
    try {
      for (let i = 0; i < 20; i++) {
        const { rows } = await this.db.query<Claim>(CLAIM_SQL, [day, process.env.DEMO_CLERK_USER_ID?.trim() ?? '']);
        const claim = rows[0];
        if (!claim) break;
        try {
          const address = await delivery.recipient(claim.clerk_id);
          if (!address || address.id !== claim.email_address_id) continue;
          // An opt-out, address change, or deletion since the claim cancels the send.
          const consent = await this.db.query('SELECT 1 FROM weekly_email_preferences WHERE user_id = $1 AND unsubscribe_id = $2',
            [claim.user_id, claim.unsubscribe_id]);
          if (!consent.rowCount) continue;
          const token = unsubscribeToken(claim.unsubscribe_id, key);
          const url = `${delivery.apiOrigin}/weekly-email/unsubscribe?token=${token}`;
          await delivery.send({
            ...weeklyMail(day, claim.saved, delivery.appOrigin, url, delivery.postalAddress),
            to: address.address,
            idempotencyKey: `weekly-${day}-${claim.unsubscribe_id}`,
          });
        } catch {
          // A network failure might mean the message was accepted. Keep the claim
          // and skip this recipient for this week rather than risking a duplicate.
          this.logger.warn('Weekly email attempt failed');
        }
      }
    } finally {
      this.running = false;
    }
  }
}
