import { ClerkLoading, SignUp } from "@clerk/nextjs";
import { Suspense } from "react";
import { larperOsAuthAppearance } from "@/components/auth/clerk-appearance";
import { LarperOsAuthShell } from "@/components/auth/larper-os-auth-shell";

// Clerk's form reads the URL (path routing) at request time, which can't be part of
// the prerendered shell under Cache Components: the shell prerenders, the form streams in.
export default function SignUpPage() {
  return (
    <LarperOsAuthShell page="sign up">
      {/* Clerk's form renders nothing until clerk-js has loaded, a few seconds on a slow
          connection: say so instead of showing an empty window. This is the one loading
          line; the Suspense around the form needs none of its own. */}
      <ClerkLoading>
        <p className="larper-os-auth-loading" role="status">loading sign-up…</p>
      </ClerkLoading>
      <Suspense fallback={null}>
        <SignUp appearance={larperOsAuthAppearance} />
      </Suspense>
    </LarperOsAuthShell>
  );
}
