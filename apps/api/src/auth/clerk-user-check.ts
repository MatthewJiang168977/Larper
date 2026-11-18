import { clerkApi, ClerkApiError, type ClerkApi } from '../demo/clerk-api';
import { isClerkUserId } from '../privacy/clerk-user-deleter';
import { privacyDeletesFromEnv } from '../privacy/privacy-deletes';

// With PRIVACY_DELETES=all, a brand-new Larper account is created only for a Clerk user
// that still exists. A session token issued before DELETE /me keeps verifying locally
// until it expires; without this check a late request with it would insert a users row
// for the deleted Clerk id, which is a tombstone (docs/decisions/0005-data-deletion.md, D7).

export const CLERK_USER_CHECK = Symbol('CLERK_USER_CHECK');

/** Resolves true if Clerk has the user, false if not (404). Throws on anything else. */
export type ClerkUserCheck = (clerkId: string) => Promise<boolean>;

export function clerkUserCheck(clerk: ClerkApi): ClerkUserCheck {
  return async (clerkId) => {
    // The id comes from a verified token, but it still goes into a URL: refuse anything
    // that is not a Clerk user id (that is "no such user", not an error).
    if (!isClerkUserId(clerkId)) return false;
    try {
      await clerk('GET', `/users/${clerkId}`);
      return true;
    } catch (err) {
      if (err instanceof ClerkApiError && err.status === 404) return false;
      throw err;
    }
  };
}

/** The check when PRIVACY_DELETES=all, else null (no Clerk call, as before). */
export function clerkUserCheckFromEnv(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): ClerkUserCheck | null {
  if (privacyDeletesFromEnv(env) !== 'all') return null;
  return clerkUserCheck(clerkApi(env.CLERK_SECRET_KEY!.trim(), fetchImpl));
}
