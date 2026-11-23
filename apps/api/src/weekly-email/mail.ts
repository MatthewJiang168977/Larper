import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ClerkApi } from '../demo/clerk-api';

const nyc = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});

/** The Thursday send opens at 7 pm New York time and closes at midnight. */
export function deliveryDay(now: Date): string | null {
  const parts = Object.fromEntries(nyc.formatToParts(now).map(({ type, value }) => [type, value]));
  return parts.weekday === 'Thu' && Number(parts.hour) >= 19 ? `${parts.year}-${parts.month}-${parts.day}` : null;
}

export function unsubscribeToken(id: string, key: Buffer): string {
  const signature = createHmac('sha256', key).update(`weekly-email:${id}`).digest('base64url');
  return `${id}.${signature}`;
}

export function verifiedUnsubscribeId(token: unknown, key: Buffer): string | null {
  if (typeof token !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const id = token.slice(0, 36);
  return timingSafeEqual(Buffer.from(token), Buffer.from(unsubscribeToken(id, key))) ? id : null;
}

export async function verifiedRecipient(clerk: ClerkApi, clerkId: string) {
  const user = await clerk<{
    primary_email_address_id: string | null;
    email_addresses: { id: string; email_address: string; verification?: { status: string } }[];
  }>('GET', `/users/${encodeURIComponent(clerkId)}`);
  const primary = user.email_addresses.find((entry) => entry.id === user.primary_email_address_id);
  return primary?.verification?.status === 'verified' ? { id: primary.id, address: primary.email_address } : null;
}

const escapeHtml = (value: string) => value
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const TEASERS = [
  'Find a record you’ve never heard and give its first track a listen.',
  'Try a tea you don’t recognize at an independent counter.',
  'Find an independent bookshop and pick a book by its first sentence.',
  'Look for a small gallery or museum you’ve passed without going in.',
];

export function weeklyMail(day: string, saved: number, appOrigin: string, unsubscribe: string, postalAddress: string) {
  const week = Math.floor(Date.parse(day) / (7 * 86_400_000));
  const teaser = TEASERS[week % TEASERS.length];
  const count = `You have ${saved} saved ${saved === 1 ? 'place' : 'places'}.`;
  const subject = 'Larper’s weekly quest';
  const text = `${subject}\n\n${teaser}\n${count}\n\nOpen Larper: ${appOrigin}\n\nLarper promotional email\n${postalAddress}\nUnsubscribe: ${unsubscribe}`;
  const html = `<div style="background:#f6d5d5;padding:16px;color:#000;font:16px/1.5 system-ui,sans-serif">
<div style="max-width:560px;margin:auto;background:#f9efe4;border:1px solid #000;border-radius:7px">
<h1 style="font-size:22px;margin:0;padding:12px 16px;border-bottom:1px solid #000">larper · weekly quest</h1>
<div style="padding:0 16px 16px"><p>${teaser}</p><p>${count}</p>
<p><a style="display:inline-block;line-height:44px;padding:0 16px;border:1px solid #000;background:#1e95a1;color:#000" href="${escapeHtml(appOrigin)}">open larper</a></p>
<p>Larper promotional email<br>${escapeHtml(postalAddress)}<br><a style="display:inline-block;line-height:44px;color:#a32a36" href="${escapeHtml(unsubscribe)}">unsubscribe</a></p></div></div></div>`;
  return { subject, text, html, headers: {
    'List-Unsubscribe': `<${unsubscribe}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  } };
}

export type Mail = ReturnType<typeof weeklyMail> & { to: string; idempotencyKey: string };
export type MailProvider = (mail: Mail) => Promise<void>;

export function resendProvider(apiKey: string, from: string, fetchImpl = fetch): MailProvider {
  return async ({ idempotencyKey, ...mail }) => {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ ...mail, from, to: [mail.to] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Weekly mail provider HTTP ${response.status}`);
  };
}
