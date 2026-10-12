import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Pages that need a signed-in user. The API enforces auth on its own; this just
// sends signed-out visitors to sign-in instead of a page full of 401s.
const isProtected = createRouteMatcher(["/onboarding(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtected(req)) await auth.protect();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
