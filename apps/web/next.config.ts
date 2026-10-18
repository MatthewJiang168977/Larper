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
  const dev = phase === PHASE_DEVELOPMENT_SERVER;
  const devProxy = dev && !apiUrl;
  return {
    // Pages named page.dev.tsx (dev tools like app/dev/map-style) are routes only in
    // `next dev`; a production build doesn't see them as pages and never bundles them.
    pageExtensions: dev ? ["dev.tsx", "tsx", "ts", "jsx", "js"] : ["tsx", "ts", "jsx", "js"],
    ...(devProxy && {
      rewrites: async () => [
        { source: "/api/:path*", destination: `${process.env.API_URL ?? "http://localhost:8080"}/:path*` },
      ],
    }),
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
}
