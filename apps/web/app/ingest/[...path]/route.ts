// /ingest: analytics events from this site (lib/analytics.ts) passed on to PostHog.
//
// A route handler, not a rewrite: a rewrite forwards every request header, and on
// this site that includes Clerk's session cookie (a sign-in token) and a Referer
// with the page's full URL (/?at=lat,lng). This forwards only:
// - POSTs to the one endpoint posthog-js uses here (events; flags, remote config,
//   replay and scripts are all off), and nothing else of PostHog's;
// - the body (capped), the SDK's query (compression, version), the content type and
//   the browser's user agent;
// - the visitor's IP as X-Forwarded-For. PostHog's cookieless mode counts visitors
//   with a hash that needs it (without it, everyone is Vercel). The PostHog project
//   discards it after that ("Discard client IP data").
// No cookies, Authorization, Origin or Referer. Nothing PostHog sets comes back.
import { NextResponse, type NextRequest } from "next/server";

export const POSTHOG_HOST = "https://us.i.posthog.com";
const EVENT_PATHS = new Set(["e", "i/v0/e", "batch"]);
export const MAX_BODY_BYTES = 1_000_000;
const UPSTREAM_TIMEOUT_MS = 10_000;

/** The visitor's IP as Vercel saw it: it sets X-Forwarded-For itself, client first. */
export function clientIp(headers: Headers): string | null {
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || headers.get("x-real-ip") || null;
}

export async function POST(request: NextRequest): Promise<Response> {
  const path = request.nextUrl.pathname.replace(/^\/ingest\/?/, "").replace(/\/+$/, "");
  if (!EVENT_PATHS.has(path)) return new NextResponse(null, { status: 404 });

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });

  const headers = new Headers();
  for (const name of ["content-type", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const ip = clientIp(request.headers);
  if (ip) headers.set("x-forwarded-for", ip);

  try {
    const upstream = await fetch(`${POSTHOG_HOST}/${path}/${request.nextUrl.search}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: "no-store",
    });
    return new NextResponse(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
