"use client";

// Vercel Web Analytics: page views only, no cookies. It's enabled in the Vercel project
// and only sends from a Vercel deployment.
import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";

/**
 * Drops the query and the fragment from every URL before it's sent. Our pages use
 * neither for content, but Clerk's sign-in flow can put tokens and redirect targets
 * there (`__clerk_*`, `redirect_url`), and none of that belongs in analytics.
 */
export function stripUrl(event: BeforeSendEvent): BeforeSendEvent {
  const url = new URL(event.url);
  url.search = "";
  url.hash = "";
  return { ...event, url: url.toString() };
}

export function WebAnalytics() {
  return <Analytics beforeSend={stripUrl} />;
}
