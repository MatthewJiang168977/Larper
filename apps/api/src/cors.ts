import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

// The web app (on Vercel) calls the API from another origin, so browsers need CORS.
// Only the origins in CORS_ORIGINS (comma-separated, exact scheme://host[:port], no
// wildcard; Helm: api.cors.origins) may read responses. Unset: no CORS headers at all,
// so only same-origin pages can.
//
// Auth is a Clerk session token in the Authorization header, never a cookie, so no
// credentials mode: browsers don't send cookies and responses don't allow them. The
// header does make every call "non-simple", so the browser first sends a preflight
// OPTIONS; Access-Control-Max-Age (CORS_MAX_AGE_S) lets it reuse the answer instead of
// preflighting each request. Preflights are answered before any guard runs, so they
// never count against a rate limit.
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

export function corsOptions(env: NodeJS.ProcessEnv = process.env): CorsOptions | null {
  const origins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!origins.length) return null;
  for (const o of origins) {
    if (!ORIGIN.test(o)) {
      throw new Error(`CORS_ORIGINS: "${o}" is not an origin (scheme://host[:port], no path, no wildcard)`);
    }
  }
  return {
    origin: origins, // exact matches only; the response echoes the one that matched
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    // A 429's wait, which the web app also reads from the body.
    exposedHeaders: ['Retry-After'],
    credentials: false,
    maxAge: Number(env.CORS_MAX_AGE_S ?? 7200),
  };
}
