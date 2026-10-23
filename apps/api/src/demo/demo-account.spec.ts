import type { ClerkApi } from './clerk-api';
import { demoConfig, restoreDemoUser, type ClerkUser } from './demo-account';

describe('demoConfig', () => {
  it('is off without a user id, and refuses a malformed id or email', () => {
    expect(demoConfig({})).toBeNull();
    expect(demoConfig({ DEMO_CLERK_USER_ID: 'user_abc', DEMO_EMAIL: 'demo@example.test' })).toEqual({
      userId: 'user_abc',
      email: 'demo@example.test',
    });
    expect(() => demoConfig({ DEMO_CLERK_USER_ID: 'user_abc/../x', DEMO_EMAIL: 'demo@example.test' })).toThrow();
    expect(() => demoConfig({ DEMO_CLERK_USER_ID: 'user_abc' })).toThrow(/DEMO_EMAIL/);
  });
});

describe('restoreDemoUser', () => {
  const cfg = { userId: 'user_demo', email: 'demo@example.test' };
  const clean: ClerkUser = {
    id: 'user_demo',
    two_factor_enabled: false,
    locked: false,
    has_image: false,
    primary_email_address_id: 'idn_demo',
    email_addresses: [{ id: 'idn_demo', email_address: 'demo@example.test' }],
    phone_numbers: [],
    external_accounts: [],
    passkeys: [],
    web3_wallets: [],
  };
  function fake(user: ClerkUser, sessions: string[] = []) {
    const calls: string[] = [];
    const bodies: Record<string, unknown> = {};
    const clerk: ClerkApi = async <T>(method: string, path: string, body?: unknown) => {
      calls.push(`${method} ${path}`);
      if (body) bodies[`${method} ${path}`] = body;
      if (path.startsWith('/sessions?')) return sessions.map((id) => ({ id })) as T;
      if (method === 'GET') return user as T;
      return {} as T;
    };
    return { clerk, calls, bodies };
  }

  it('signs everyone out and rotates the password, even when nothing else changed', async () => {
    const { clerk, calls, bodies } = fake(clean, ['sess_1', 'sess_2']);
    const done = await restoreDemoUser(clerk, cfg);
    expect(calls).toEqual([
      'GET /sessions?user_id=user_demo&status=active&limit=500',
      'POST /sessions/sess_1/revoke',
      'POST /sessions/sess_2/revoke',
      'GET /users/user_demo',
      'PATCH /users/user_demo',
    ]);
    const patch = bodies['PATCH /users/user_demo'] as Record<string, unknown>;
    expect(patch).toMatchObject({ delete_self_enabled: false, create_organization_enabled: false, first_name: '' });
    expect(String(patch.password).length).toBeGreaterThanOrEqual(30);
    expect(done[0]).toBe('revoked 2 session(s)');
  });

  it("takes off what visitors added and puts the demo email back as primary", async () => {
    const { clerk, calls } = fake({
      ...clean,
      two_factor_enabled: true,
      has_image: true,
      primary_email_address_id: 'idn_theirs',
      email_addresses: [...clean.email_addresses, { id: 'idn_theirs', email_address: 'them@example.test' }],
      phone_numbers: [{ id: 'idn_phone' }],
      external_accounts: [{ id: 'eac_1' }],
      passkeys: [{ id: 'pk_1' }],
      web3_wallets: [{ id: 'w3w_1' }],
    });
    await restoreDemoUser(clerk, cfg);
    expect(calls).toEqual(
      expect.arrayContaining([
        'DELETE /users/user_demo/mfa',
        'PATCH /email_addresses/idn_demo',
        'DELETE /email_addresses/idn_theirs',
        'DELETE /phone_numbers/idn_phone',
        'DELETE /users/user_demo/external_accounts/eac_1',
        'DELETE /users/user_demo/passkeys/pk_1',
        'DELETE /users/user_demo/web3_wallets/w3w_1',
        'DELETE /users/user_demo/profile_image',
      ]),
    );
    expect(calls).not.toContain('DELETE /email_addresses/idn_demo');
  });

  it('re-adds the demo email, verified, if a visitor removed it', async () => {
    const { clerk, calls } = fake({
      ...clean,
      primary_email_address_id: 'idn_theirs',
      email_addresses: [{ id: 'idn_theirs', email_address: 'them@example.test' }],
    });
    await restoreDemoUser(clerk, cfg);
    expect(calls.indexOf('POST /email_addresses')).toBeLessThan(calls.indexOf('DELETE /email_addresses/idn_theirs'));
  });
});
