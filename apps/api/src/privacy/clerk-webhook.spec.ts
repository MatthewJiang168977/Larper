import { createHmac } from 'node:crypto';
import { verifySvix, webhookSecretFromEnv, WEBHOOK_TOLERANCE_S } from './clerk-webhook';

// A made-up signing secret: 24 random-looking bytes, base64, in Clerk's whsec_ format.
const KEY = Buffer.from('larper-test-webhook-key-0123', 'utf8');
const SECRET = `whsec_${KEY.toString('base64')}`;
const NOW = 1_795_000_000_000;
const TS = String(Math.floor(NOW / 1000));
const BODY = Buffer.from('{"type":"user.deleted","data":{"id":"user_abc123","deleted":true}}');

const sign = (id: string, ts: string, body: Buffer, key = KEY) =>
  createHmac('sha256', key).update(`${id}.${ts}.`).update(body).digest('base64');

describe('webhookSecretFromEnv', () => {
  it('is off when unset or blank', () => {
    expect(webhookSecretFromEnv({})).toBeNull();
    expect(webhookSecretFromEnv({ CLERK_WEBHOOK_SIGNING_SECRET: '  ' })).toBeNull();
  });

  it('decodes a whsec_ secret', () => {
    expect(webhookSecretFromEnv({ CLERK_WEBHOOK_SIGNING_SECRET: SECRET })?.equals(KEY)).toBe(true);
  });

  it('fails startup on anything else', () => {
    expect(() => webhookSecretFromEnv({ CLERK_WEBHOOK_SIGNING_SECRET: 'sk_live_nope' })).toThrow(/whsec_/);
    expect(() => webhookSecretFromEnv({ CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_c2hvcnQ=' })).toThrow(/whsec_/);
  });
});

describe('verifySvix', () => {
  const key = webhookSecretFromEnv({ CLERK_WEBHOOK_SIGNING_SECRET: SECRET })!;
  const ok = { id: 'msg_1', timestamp: TS, signature: `v1,${sign('msg_1', TS, BODY)}` };

  it('accepts a correct, recent signature', () => {
    expect(verifySvix(key, ok, BODY, NOW)).toBe(true);
  });

  it('accepts when any one of several signatures matches (secret rotation)', () => {
    const signature = `v1,${sign('msg_1', TS, BODY, Buffer.from('an-old-rotated-key-000000'))} v1,${sign('msg_1', TS, BODY)}`;
    expect(verifySvix(key, { ...ok, signature }, BODY, NOW)).toBe(true);
  });

  it('refuses a changed body, id or timestamp', () => {
    expect(verifySvix(key, ok, Buffer.from(BODY.toString().replace('abc123', 'xyz999')), NOW)).toBe(false);
    expect(verifySvix(key, { ...ok, id: 'msg_2' }, BODY, NOW)).toBe(false);
    expect(verifySvix(key, { ...ok, timestamp: String(Number(TS) + 1) }, BODY, NOW)).toBe(false);
  });

  it('refuses a signature made with another key', () => {
    const signature = `v1,${sign('msg_1', TS, BODY, Buffer.from('someone-elses-key-0000000'))}`;
    expect(verifySvix(key, { ...ok, signature }, BODY, NOW)).toBe(false);
  });

  it('refuses a stale or future timestamp (replay), even if signed', () => {
    const old = String(Number(TS) - WEBHOOK_TOLERANCE_S - 1);
    expect(verifySvix(key, { id: 'msg_1', timestamp: old, signature: `v1,${sign('msg_1', old, BODY)}` }, BODY, NOW)).toBe(false);
    const future = String(Number(TS) + WEBHOOK_TOLERANCE_S + 1);
    expect(verifySvix(key, { id: 'msg_1', timestamp: future, signature: `v1,${sign('msg_1', future, BODY)}` }, BODY, NOW)).toBe(false);
  });

  it('refuses missing headers, other versions and junk without throwing', () => {
    expect(verifySvix(key, {}, BODY, NOW)).toBe(false);
    expect(verifySvix(key, { ...ok, signature: undefined }, BODY, NOW)).toBe(false);
    expect(verifySvix(key, { ...ok, timestamp: 'soon' }, BODY, NOW)).toBe(false);
    expect(verifySvix(key, { ...ok, signature: ok.signature.replace('v1,', 'v2,') }, BODY, NOW)).toBe(false);
    expect(verifySvix(key, { ...ok, signature: 'v1,!!!not-base64' }, BODY, NOW)).toBe(false);
    expect(verifySvix(key, { ...ok, signature: 'v1' }, BODY, NOW)).toBe(false);
  });
});
