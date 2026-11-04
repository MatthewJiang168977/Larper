// What may leave the browser (or the web server) in a Sentry event: no emails, no
// tokens or Clerk IDs, no cookies or auth headers, no coordinates, no quest or place
// IDs. Applied to errors, transactions and breadcrumbs (lib/sentry-options.ts).
//
// It works on the whole event, not on known fields: an error message, a breadcrumb's
// URL and a span's attributes all carry the same kinds of strings.

const FILTERED = "[Filtered]";

/** Keys whose values are dropped wherever they appear (compared lowercased, without _ and -). */
const DROP_KEYS = new Set(
  [
    "cookie", "cookies", "set-cookie", "authorization", "x-clerk-auth-token",
    "email", "emailaddress", "token", "ticket", "password", "secret",
    "lat", "lng", "lon", "latitude", "longitude", "accuracy", "accuracym", "coords", "coordinates",
    "placeid", "questid", "place", "placename", "address",
    "ip", "ipaddress",
  ].map((k) => k.replace(/[-_]/g, "")),
);

const PATTERNS: [RegExp, string][] = [
  // Clerk IDs and secret keys (as in loadtest/redact.js), JWTs, bearer tokens.
  [/\b(sess|user|client|sms|idn|org|ins|sk_test|sk_live|pk_test|pk_live)_[A-Za-z0-9]{8,}\b/g, "$1_[Filtered]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[JWT]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [Filtered]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  // Coordinates: query parameters, and "40.7301, -73.9965"-style pairs.
  [/\b(lat|lng|lon|latitude|longitude|accuracy)=[^&#\s]*/gi, "$1=[Filtered]"],
  [/-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/g, "[coords]"],
  // Quest and place IDs in paths: /quests/123/accept -> /quests/:id/accept.
  [/\/(quests|places)\/\d+/g, "/$1/:id"],
];

export function scrubString(s: string): string {
  let out = s;
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}

const normalizeKey = (k: string) => k.toLowerCase().replace(/[-_]/g, "");

/** A deep copy with dropped keys filtered and every string scrubbed. */
export function scrubValue<T>(value: T, depth = 0): T {
  if (depth > 12) return FILTERED as T;
  if (typeof value === "string") return scrubString(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = DROP_KEYS.has(normalizeKey(k)) ? FILTERED : scrubValue(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

type Scrubbable = {
  user?: unknown;
  request?: { url?: string; query_string?: unknown; cookies?: unknown; headers?: Record<string, string>; data?: unknown };
};

/**
 * For beforeSend and beforeSendTransaction: no user (Sentry would add the IP), no
 * cookies, no request body or query, then every string scrubbed.
 */
export function scrubEvent<E extends object>(event: E): E {
  const e: Scrubbable = { ...event };
  delete e.user;
  if (e.request) {
    const { url, headers } = e.request;
    e.request = {
      ...(url && { url: url.split(/[?#]/)[0] }),
      ...(headers && { headers }),
    };
  }
  return scrubValue(e) as E;
}
