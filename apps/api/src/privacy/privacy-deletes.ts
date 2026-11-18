import { ServiceUnavailableException } from '@nestjs/common';

// The rollout gate for the delete routes (docs/decisions/0005-data-deletion.md, "Rollout
// and rollback"). Off by default, so a deploy in any order leaves them unavailable until
// the owner turns a value on: `history` opens DELETE /me/history, `all` opens that and
// DELETE /me (which also deletes the Clerk user, so it needs CLERK_SECRET_KEY; 0005 D7).

export const PRIVACY_DELETES = Symbol('PRIVACY_DELETES');

export type PrivacyDeletes = 'off' | 'history' | 'all';

/**
 * Parses PRIVACY_DELETES. Unset or empty is off; anything unknown fails startup, and so
 * does `all` without CLERK_SECRET_KEY.
 */
export function privacyDeletesFromEnv(env: NodeJS.ProcessEnv): PrivacyDeletes {
  const v = env.PRIVACY_DELETES?.trim().toLowerCase();
  if (!v || v === 'off') return 'off';
  if (v === 'history') return 'history';
  if (v === 'all') {
    if (!env.CLERK_SECRET_KEY?.trim()) throw new Error('PRIVACY_DELETES=all needs CLERK_SECRET_KEY, which is not set');
    return 'all';
  }
  throw new Error(`PRIVACY_DELETES must be "off", "history" or "all" (got "${env.PRIVACY_DELETES?.trim()}")`);
}

export interface PrivacyCapability {
  export: boolean;
  deleteHistory: boolean;
  deleteAccount: boolean;
}

/** What GET /me tells the web app it may offer. Nothing is offered to the shared demo account. */
export function privacyCapability(mode: PrivacyDeletes, demo: boolean): PrivacyCapability {
  if (demo) return { export: false, deleteHistory: false, deleteAccount: false };
  return { export: true, deleteHistory: mode !== 'off', deleteAccount: mode === 'all' };
}

export const DELETES_UNAVAILABLE = {
  statusCode: 503,
  code: 'deletes_unavailable',
  message: "deleting isn't available yet",
};

/** 503 with no Retry-After: the owner turns this on, not the clock. */
export function deletesUnavailable() {
  return new ServiceUnavailableException(DELETES_UNAVAILABLE);
}
