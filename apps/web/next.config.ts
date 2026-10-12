import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The browser only ever talks to this origin; /api/* is proxied to the NestJS
  // API (k3d ingress locally). Same origin means no CORS and one cookie domain.
  rewrites: async () => [
    { source: "/api/:path*", destination: `${process.env.API_URL ?? "http://localhost:8080"}/:path*` },
  ],
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

export default nextConfig;
