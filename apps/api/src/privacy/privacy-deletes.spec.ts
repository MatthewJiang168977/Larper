import { DELETES_UNAVAILABLE, privacyCapability, privacyDeletesFromEnv } from './privacy-deletes';

describe('PRIVACY_DELETES', () => {
  it('is off when unset, empty or blank', () => {
    for (const v of [undefined, '', '  ', 'off', 'OFF']) expect(privacyDeletesFromEnv({ PRIVACY_DELETES: v })).toBe('off');
    expect(privacyDeletesFromEnv({})).toBe('off');
  });

  it('is history only for history', () => {
    for (const v of ['history', ' History ']) expect(privacyDeletesFromEnv({ PRIVACY_DELETES: v })).toBe('history');
  });

  it('is all only with a Clerk secret key', () => {
    expect(privacyDeletesFromEnv({ PRIVACY_DELETES: 'all', CLERK_SECRET_KEY: 'sk_test_mock' })).toBe('all');
    expect(privacyDeletesFromEnv({ PRIVACY_DELETES: ' ALL ', CLERK_SECRET_KEY: ' sk_test_mock ' })).toBe('all');
    for (const key of [undefined, '', '   ']) {
      expect(() => privacyDeletesFromEnv({ PRIVACY_DELETES: 'all', CLERK_SECRET_KEY: key })).toThrow(/needs CLERK_SECRET_KEY/);
    }
  });

  it('does not need the key for history', () => {
    expect(privacyDeletesFromEnv({ PRIVACY_DELETES: 'history' })).toBe('history');
  });

  it('fails startup on anything else', () => {
    for (const v of ['account', '1', 'true', 'on', 'histroy']) {
      expect(() => privacyDeletesFromEnv({ PRIVACY_DELETES: v, CLERK_SECRET_KEY: 'k' })).toThrow(/PRIVACY_DELETES must be "off", "history" or "all"/);
    }
  });

  it('reports what the web app may offer', () => {
    expect(privacyCapability('off', false)).toEqual({ export: true, deleteHistory: false, deleteAccount: false });
    expect(privacyCapability('history', false)).toEqual({ export: true, deleteHistory: true, deleteAccount: false });
    expect(privacyCapability('all', false)).toEqual({ export: true, deleteHistory: true, deleteAccount: true });
    for (const mode of ['off', 'history', 'all'] as const) {
      expect(privacyCapability(mode, true)).toEqual({ export: false, deleteHistory: false, deleteAccount: false });
    }
  });

  it('has the agreed 503 body', () => {
    expect(DELETES_UNAVAILABLE).toEqual({ statusCode: 503, code: 'deletes_unavailable', message: "deleting isn't available yet" });
  });
});
