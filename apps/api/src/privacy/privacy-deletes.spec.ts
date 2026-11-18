import { DELETES_UNAVAILABLE, privacyCapability, privacyDeletesFromEnv } from './privacy-deletes';

describe('PRIVACY_DELETES', () => {
  it('is off when unset, empty or blank', () => {
    for (const v of [undefined, '', '  ', 'off', 'OFF']) expect(privacyDeletesFromEnv({ PRIVACY_DELETES: v })).toBe('off');
    expect(privacyDeletesFromEnv({})).toBe('off');
  });

  it('is history only for history', () => {
    for (const v of ['history', ' History ']) expect(privacyDeletesFromEnv({ PRIVACY_DELETES: v })).toBe('history');
  });

  it('fails startup on anything else, including values that are not available yet', () => {
    for (const v of ['all', 'account', '1', 'true', 'on', 'histroy']) {
      expect(() => privacyDeletesFromEnv({ PRIVACY_DELETES: v })).toThrow(/PRIVACY_DELETES must be "off" or "history"/);
    }
  });

  it('reports what the web app may offer', () => {
    expect(privacyCapability('off', false)).toEqual({ export: true, deleteHistory: false, deleteAccount: false });
    expect(privacyCapability('history', false)).toEqual({ export: true, deleteHistory: true, deleteAccount: false });
    for (const mode of ['off', 'history'] as const) {
      expect(privacyCapability(mode, true)).toEqual({ export: false, deleteHistory: false, deleteAccount: false });
    }
  });

  it('has the agreed 503 body', () => {
    expect(DELETES_UNAVAILABLE).toEqual({ statusCode: 503, code: 'deletes_unavailable', message: "deleting isn't available yet" });
  });
});
