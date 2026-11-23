import { createHmac, timingSafeEqual } from 'node:crypto';

// Clerk sends webhooks through Svix. A request is genuine when one of the `v1,<base64>`
// signatures in `svix-signature` equals HMAC-SHA256(secret, `${id}.${timestamp}.${body}`),
// where the secret is the base64 after `whsec_`, and the timestamp is recent.
// https://docs.svix.com/receiving/verifying-payloads/how-manual
// Written out here rather than adding the svix package for ~20 lines.

/** How far a webhook's timestamp may be from now, either way. Svix uses 5 minutes. */
export const WEBHOOK_TOLERANCE_S = 5 * 60;

export interface SvixHeaders {
  id?: string;
  timestamp?: string;
  signature?: string;
}

/** The signing secret from CLERK_WEBHOOK_SIGNING_SECRET, or null when the webhook is off. Bad values fail startup. */
export function webhookSecretFromEnv(env: NodeJS.ProcessEnv): Buffer | null {
  const raw = env.CLERK_WEBHOOK_SIGNING_SECRET?.trim();
  if (!raw) return null;
  const m = /^whsec_([A-Za-z0-9+/=]+)$/.exec(raw);
  const key = m ? Buffer.from(m[1], 'base64') : null;
  if (!key || key.length < 16) throw new Error('CLERK_WEBHOOK_SIGNING_SECRET must be a Clerk signing secret (whsec_...)');
  return key;
}

/** True only for a correctly signed, recent request. Never throws. */
export function verifySvix(secret: Buffer, headers: SvixHeaders, body: Buffer, nowMs = Date.now()): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_S) return false;
  const expected = createHmac('sha256', secret).update(`${id}.${timestamp}.`).update(body).digest();
  for (const part of signature.split(' ')) {
    const [version, sig] = part.split(',', 2);
    if (version !== 'v1' || !sig) continue;
    const given = Buffer.from(sig, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}
