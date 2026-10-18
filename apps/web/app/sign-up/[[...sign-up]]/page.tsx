import { SignUp } from "@clerk/nextjs";
import { Suspense } from "react";

// Clerk's form reads the URL (path routing) at request time, which can't be part of
// the prerendered shell under Cache Components: the shell prerenders, the form streams in.
export default function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Suspense fallback={<p className="field-label">Loading sign-up…</p>}>
        <SignUp />
      </Suspense>
    </div>
  );
}
