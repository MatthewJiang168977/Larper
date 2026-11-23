import { ClerkLoading, SignIn } from "@clerk/nextjs";
import { Suspense } from "react";
import { signInAppearance } from "@/components/auth/demo-account";
import { LarperOsAuthShell } from "@/components/auth/larper-os-auth-shell";
import { DemoPanel } from "@/components/auth/try-demo";

// Clerk's form reads the URL (path routing) at request time, which can't be part of
// the prerendered shell under Cache Components: the shell prerenders, the form streams in.
export default function SignInPage() {
  return (
    <LarperOsAuthShell title="sign in">
      {/* Clerk's form renders nothing until clerk-js has loaded, a few seconds on a slow
          connection: say so instead of showing an empty window. This is the one loading
          line; the Suspense around the form needs none of its own. */}
      <ClerkLoading>
        <p className="larper-os-auth-loading" role="status">loading sign-in…</p>
      </ClerkLoading>
      <Suspense fallback={null}>
        <SignIn appearance={signInAppearance(process.env.NEXT_PUBLIC_SIGNUP_MODE)} />
      </Suspense>
      <DemoPanel signUpMode={process.env.NEXT_PUBLIC_SIGNUP_MODE} />
    </LarperOsAuthShell>
  );
}
