import { clerkApi, ClerkApiError, type ClerkApi } from '../demo/clerk-api';
import { privacyDeletesFromEnv } from './privacy-deletes';

// DELETE /me deletes the Clerk user after the local purge (docs/decisions/0005-data-deletion.md,
// D7). That is a use of CLERK_SECRET_KEY in the API pod, so it exists only when
// PRIVACY_DELETES=all (which refuses to start without the key).

export const CLERK_USER_DELETER = Symbol('CLERK_USER_DELETER');

/** Deletes one Clerk user. Resolves when it is gone, including when it already was (404). */
export type ClerkUserDeleter = (clerkId: string) => Promise<void>;

export function clerkUserDeleter(clerk: ClerkApi): ClerkUserDeleter {
  return async (clerkId) => {
    // The id is a Clerk user id from our own session check; refuse anything else before it
    // goes into a URL.
    if (!/^user_[A-Za-z0-9]+$/.test(clerkId)) throw new Error('not a Clerk user id');
    try {
      await clerk('DELETE', `/users/${clerkId}`);
    } catch (err) {
      if (err instanceof ClerkApiError && err.status === 404) return;
      throw err;
    }
  };
}

/** The deleter when PRIVACY_DELETES=all, else null. A bad setting fails the API at startup. */
export function clerkUserDeleterFromEnv(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): ClerkUserDeleter | null {
  if (privacyDeletesFromEnv(env) !== 'all') return null;
  return clerkUserDeleter(clerkApi(env.CLERK_SECRET_KEY!.trim(), fetchImpl));
}
