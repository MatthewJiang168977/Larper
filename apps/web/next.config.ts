import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";

// The browser calls the API directly at NEXT_PUBLIC_API_URL (lib/api.ts), cross-origin:
// the API allows this app's origin (Helm api.cors.origins). In production (Vercel)
// it must be set, and a build without it fails: a proxy through this app would make
// every request come from Vercel's addresses (one client to the API's per-IP limit)
// and put a second public path to the API in front of it.
//
// Local dev may leave it unset: then, under `next dev` only, /api/* is proxied to
// API_URL (the k3d ingress, http://localhost:8080 by default).
//
// /ingest (analytics, to PostHog) is a route handler, not a rewrite:
// app/ingest/[...path]/route.ts says why. CI checks a production build has no rewrites.
export default function config(phase: string): NextConfig {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  // `next typegen` (pnpm typecheck) loads this in the build phase too, but builds nothing.
  const typegen = process.argv.includes("typegen");
  if (phase === PHASE_PRODUCTION_BUILD && !typegen && !apiUrl) {
    throw new Error(
      "NEXT_PUBLIC_API_URL is not set. A production build calls the API directly at that URL " +
        "(e.g. https://api.example.com); the /api proxy exists only in `next dev`.",
    );
  }
  const devProxy = phase === PHASE_DEVELOPMENT_SERVER && !apiUrl;
  const nextConfig: NextConfig = {
    ...(devProxy && {
      rewrites: async () => [
        { source: "/api/:path*", destination: `${process.env.API_URL ?? "http://localhost:8080"}/:path*` },
      ],
    }),
    // posthog-js posts to /ingest/e/: no redirect that drops the slash.
    skipTrailingSlashRedirect: true,
    cacheComponents: true,
    partialPrefetching: true,
    turbopack: {
      rules: {
        "*.css": {
          loaders: ["@tailwindcss/turbopack"],
          as: "*.css",
        },
      },
    },
  };
  return withSentryConfig(nextConfig, sentryBuildOptions(phase === PHASE_PRODUCTION_BUILD && !typegen));
}

// Sentry at build time: the release is the commit, and the browser's source maps go
// to Sentry and are then deleted from the build, so they're never served.
//
// A Vercel production build must upload them: without SENTRY_AUTH_TOKEN (or the DSN)
// it fails, like a missing NEXT_PUBLIC_API_URL. Every other build (local, CI, preview)
// turns source maps off entirely, so none are generated and none can be left behind.
function sentryBuildOptions(build: boolean): Parameters<typeof withSentryConfig>[1] {
  const production = build && process.env.VERCEL_ENV === "production";
  if (production) {
    for (const name of ["SENTRY_AUTH_TOKEN", "NEXT_PUBLIC_SENTRY_DSN", "SENTRY_ORG", "SENTRY_PROJECT"]) {
      if (!process.env[name]) {
        throw new Error(`${name} is not set. A Vercel production build uploads its source maps to Sentry.`);
      }
    }
  }
  return {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    release: { name: process.env.VERCEL_GIT_COMMIT_SHA },
    sourcemaps: production ? { deleteSourcemapsAfterUpload: true } : { disable: true },
    telemetry: false,
    silent: !production,
  };
}
