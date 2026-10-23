// A minimal client for Clerk's Backend API (https://api.clerk.com/v1), for the demo
// account only: the sign-in endpoint and the nightly reset. The secret key never
// leaves the Authorization header, and errors carry the status, never a body.

const CLERK_API = 'https://api.clerk.com/v1';
const TIMEOUT_MS = 10_000;

export class ClerkApiError extends Error {
  constructor(
    readonly status: number,
    call: string,
  ) {
    super(`Clerk ${call}: HTTP ${status}`);
    this.name = 'ClerkApiError';
  }
}

export type ClerkApi = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

export function clerkApi(secretKey: string, fetchImpl: typeof fetch = fetch): ClerkApi {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    // Some POSTs (session tokens) refuse an empty body: send {} for any POST without one.
    const payload = body ?? (method === 'POST' ? {} : undefined);
    const res = await fetchImpl(`${CLERK_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new ClerkApiError(res.status, `${method} ${path.split('?')[0]}`);
    return (await res.json()) as T;
  };
}
