// Verifies a bearer token and returns the Clerk user id. Injected (rather than
// imported) so tests can swap in a fake without real JWTs.
export type SessionVerifier = (token: string) => Promise<{ clerkId: string }>;
export const SESSION_VERIFIER = Symbol('SESSION_VERIFIER');
