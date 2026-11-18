import { ServiceUnavailableException } from '@nestjs/common';

// The rollout gate for the delete routes (docs/decisions/0005-data-deletion.md, "Rollout
// and rollback"). Off by default, so a deploy in any order leaves them unavailable until
// the owner turns `history` on. There is deliberately no value for DELETE /me yet: it
// stays unavailable until the account lifecycle (0005 D7) is decided and built.

export const PRIVACY_DELETES = Symbol('PRIVACY_DELETES');

export type PrivacyDeletes = 'off' | 'history';

/** Parses PRIVACY_DELETES. Unset or empty is off; anything else unknown fails startup. */
export function privacyDeletesFromEnv(env: NodeJS.ProcessEnv): PrivacyDeletes {
  const v = env.PRIVACY_DELETES?.trim().toLowerCase();
  if (!v || v === 'off') return 'off';
  if (v === 'history') return 'history';
  throw new Error(`PRIVACY_DELETES must be "off" or "history" (got "${env.PRIVACY_DELETES?.trim()}")`);
}

export interface PrivacyCapability {
  export: boolean;
  deleteHistory: boolean;
  deleteAccount: boolean;
}

/** What GET /me tells the web app it may offer. Nothing is offered to the shared demo account. */
export function privacyCapability(mode: PrivacyDeletes, demo: boolean): PrivacyCapability {
  if (demo) return { export: false, deleteHistory: false, deleteAccount: false };
  return { export: true, deleteHistory: mode === 'history', deleteAccount: false };
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
