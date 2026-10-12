import { clerkMiddleware } from "@clerk/nextjs/server";

// Attaches Clerk's auth state to requests. Page-level checks live in the pages
// (components/require-sign-in.tsx); the API verifies tokens itself.
export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
