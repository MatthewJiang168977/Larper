import { clerkApi, ClerkApiError, type ClerkApi } from '../demo/clerk-api';

// Deleting the Clerk user along with the account's data (DELETE /me) is off by default:
// it is a second use of CLERK_SECRET_KEY in the cluster, and a live-system write per
// request (docs/plans/industry-ready-plan.md, D7). Off, the owner removes the Clerk user
// by hand. On when CLERK_DELETE_USERS is "1" or "true" (not wired into Helm yet; see
// docs/decisions/0005-data-deletion.md), which also needs CLERK_SECRET_KEY.

export const CLERK_USER_DELETER = Symbol('CLERK_USER_DELETER');

/** Deletes one Clerk user. Resolves when it is gone, including when it already was (404). */
export type ClerkUserDeleter = (clerkId: string) => Promise<void>;

export function clerkDeleteEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.CLERK_DELETE_USERS?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

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

/** The deleter when CLERK_DELETE_USERS is on, else null. A bad setting fails the API at startup. */
export function clerkUserDeleterFromEnv(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): ClerkUserDeleter | null {
  if (!clerkDeleteEnabled(env)) return null;
  const key = env.CLERK_SECRET_KEY?.trim();
  if (!key) throw new Error('CLERK_DELETE_USERS is on but CLERK_SECRET_KEY is not set');
  return clerkUserDeleter(clerkApi(key, fetchImpl));
}
