import { createPool } from '../db/db.module';
import { assertDisposableDatabase } from '../db/test-guard';
import { WeeklyEmailService } from './weekly-email.service';

const URL = process.env.TEST_DATABASE_URL;
const describeDb = URL ? describe : describe.skip;

describeDb('weekly email with a disposable database', () => {
  it('claims one delivery across replicas, honors opt-out, and cascades when the user is deleted', async () => {
    const db = createPool(URL);
    const owner = createPool(process.env.TEST_OWNER_DATABASE_URL ?? URL);
    let userId: string | undefined;
    try {
      await assertDisposableDatabase(owner, 'weekly-email.db.spec');
      const { rows } = await owner.query<{ id: string; clerk_id: string }>(
        "INSERT INTO users (clerk_id) VALUES ('test_weekly_email_' || gen_random_uuid()) RETURNING id::text, clerk_id",
      );
      userId = rows[0].id;
      const user = { id: userId, clerkId: rows[0].clerk_id };
      const send = jest.fn(async () => undefined);
      const config = { key: Buffer.alloc(32, 1), delivery: { send,
        recipient: async () => ({ id: 'idn_fixture', address: 'fixture@example.test' }),
        appOrigin: 'https://app.example.test', apiOrigin: 'https://api.example.test', postalAddress: 'Mailbox 1',
      } };
      const a = new WeeklyEmailService(db, config);
      const b = new WeeklyEmailService(db, config);
      await a.setPreference(user, true);
      await Promise.all([a.runDue(new Date('2026-11-20T00:00:00Z')), b.runDue(new Date('2026-11-20T00:00:00Z'))]);
      expect(send).toHaveBeenCalledTimes(1);
      await a.setPreference(user, false);
      await b.runDue(new Date('2026-11-27T00:00:00Z'));
      expect(send).toHaveBeenCalledTimes(1);
      await owner.query('DELETE FROM users WHERE id = $1', [userId]);
      const result = await db.query('SELECT 1 FROM weekly_email_preferences WHERE user_id = $1', [userId]);
      expect(result.rowCount).toBe(0);
    } finally {
      if (userId) await owner.query('DELETE FROM users WHERE id = $1', [userId]);
      await Promise.all([db.end(), owner.end()]);
    }
  });
});
