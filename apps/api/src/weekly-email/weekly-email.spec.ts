import type { Pool } from 'pg';
import { deliveryDay, unsubscribeToken, verifiedUnsubscribeId, weeklyMail } from './mail';
import { WeeklyEmailService, weeklyEmailFromEnv, type WeeklyEmailConfig } from './weekly-email.service';
import { WeeklyEmailUnsubscribeController } from './weekly-email.controller';

const key = Buffer.alloc(32, 7);
const now = new Date('2026-11-20T00:00:00Z');
const unsubscribeId = '6c20649d-bb12-44bc-9691-0fb30a86bc88';
const token = unsubscribeToken(unsubscribeId, key);
const user = { id: '1', clerkId: 'user_fixture' };

function fixture(address = { id: 'idn_verified', address: 'sample@example.test' }) {
  const send = jest.fn(async () => undefined);
  const recipient = jest.fn(async () => address);
  const query = jest.fn();
  const config: WeeklyEmailConfig = {
    key, delivery: { send, recipient, appOrigin: 'https://app.example.test', apiOrigin: 'https://api.example.test', postalAddress: 'Mailbox 1' },
  };
  return { service: new WeeklyEmailService({ query } as unknown as Pool, config), send, recipient, query };
}

it.each([
  ['2026-11-19T23:59:00Z', null],
  ['2026-11-20T00:00:00Z', '2026-11-19'],
  ['2026-07-16T23:00:00Z', '2026-07-16'],
  ['2026-07-17T04:00:00Z', null],
])('uses the New York Thursday window at %s', (instant, expected) => {
  expect(deliveryDay(new Date(instant))).toBe(expected);
});

it('is off by default and can keep unsubscribe available after sending is paused', async () => {
  const config = weeklyEmailFromEnv({ WEEKLY_EMAIL_UNSUBSCRIBE_KEY: key.toString('base64url') });
  const query = jest.fn();
  const service = new WeeklyEmailService({ query } as unknown as Pool, config);
  await service.runDue(now);
  await expect(service.preference(user)).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
  expect(service.checkUnsubscribe(token)).toBe(unsubscribeId);
});

it('signs opaque opt-outs and ignores GETs from email scanners', async () => {
  const { service, query } = fixture();
  const controller = new WeeklyEmailUnsubscribeController(service);
  expect(verifiedUnsubscribeId(token, key)).toBe(unsubscribeId);
  expect(verifiedUnsubscribeId(token.slice(0, -1) + '!', key)).toBeNull();
  expect(verifiedUnsubscribeId(token, Buffer.alloc(32, 1))).toBeNull();
  expect(controller.confirm(token)).toContain('method="post"');
  expect(query).not.toHaveBeenCalled();
  expect(await controller.unsubscribe(token)).toContain('unsubscribed');
  expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE unsubscribe_id = $1'), [unsubscribeId]);
});

it('requires an explicit verified-address opt-in and clears it on opt-out', async () => {
  const { service, query, recipient } = fixture();
  query.mockResolvedValue({ rows: [] });
  expect(await service.preference(user)).toEqual({ enabled: false });
  expect(recipient).not.toHaveBeenCalled();
  await expect(service.setPreference(user, undefined)).rejects.toThrow();
  expect(await service.setPreference(user, true)).toEqual({ enabled: true });
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining('INSERT INTO weekly_email_preferences'), [
    user.id, 'idn_verified', expect.any(String),
  ]);
  expect(await service.setPreference(user, false)).toEqual({ enabled: false });
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining('unsubscribe_id = NULL'), [user.id]);
});

it('sends only the teaser and saved count and provides a one-click header', async () => {
  const { service, query, send } = fixture();
  query
    .mockResolvedValueOnce({ rows: [{ user_id: '1', clerk_id: user.clerkId, email_address_id: 'idn_verified', unsubscribe_id: unsubscribeId, saved: 3 }] })
    .mockResolvedValueOnce({ rowCount: 1 })
    .mockResolvedValue({ rows: [] });
  await service.runDue(now);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    to: 'sample@example.test',
    text: expect.stringContaining('You have 3 saved places.'),
    headers: {
      'List-Unsubscribe': `<https://api.example.test/weekly-email/unsubscribe?token=${token}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }));
  expect(weeklyMail('2026-11-19', 1, 'https://app.example.test', 'https://api.example.test', '<mailbox>').html)
    .toContain('&lt;mailbox&gt;');
});

it.each(['changed address', 'opted out'])('skips a claimed message if the recipient %s', async (reason) => {
  const { service, query, send } = fixture({ id: reason === 'changed address' ? 'different' : 'idn_verified', address: 'a@example.test' });
  query.mockResolvedValueOnce({ rows: [
    { user_id: '1', clerk_id: user.clerkId, email_address_id: 'idn_verified', unsubscribe_id: unsubscribeId, saved: 3 },
  ] }).mockResolvedValue({ rows: [], rowCount: 0 });
  await service.runDue(now);
  expect(send).not.toHaveBeenCalled();
});
