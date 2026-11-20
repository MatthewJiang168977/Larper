import { SignUp } from "@clerk/nextjs";
import { Suspense } from "react";
import { larperOsAuthAppearance } from "@/components/auth/clerk-appearance";
import { LarperOsAuthShell } from "@/components/auth/larper-os-auth-shell";

// Clerk's form reads the URL (path routing) at request time, which can't be part of
// the prerendered shell under Cache Components: the shell prerenders, the form streams in.
export default function SignUpPage() {
  return (
    <LarperOsAuthShell title="sign up">
      <Suspense fallback={<p className="larper-os-auth-loading" role="status">loading sign-up…</p>}>
        <SignUp appearance={larperOsAuthAppearance} />
      </Suspense>
    </LarperOsAuthShell>
  );
}
