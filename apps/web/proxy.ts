import { clerkMiddleware } from "@clerk/nextjs/server";

// Attaches Clerk's auth state to requests. Page-level checks live in the pages
// (components/require-sign-in.tsx); the API verifies tokens itself.
//
// Not on /ingest/* (analytics, passed on to PostHog by app/ingest): it carries no
// session and needs none, and Clerk running on it could get in the events' way.
export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|ingest/|[^?]*\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
