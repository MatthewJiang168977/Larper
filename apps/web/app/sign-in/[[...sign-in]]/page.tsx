import { SignIn } from "@clerk/nextjs";
import { Suspense } from "react";
import { DemoAccount, signInAppearance } from "@/components/auth/demo-account";

// Clerk's form reads the URL (path routing) at request time, which can't be part of
// the prerendered shell under Cache Components: the shell prerenders, the form streams in.
export default function SignInPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4">
      <Suspense fallback={<p className="field-label">Loading sign-in…</p>}>
        <SignIn appearance={signInAppearance(process.env.NEXT_PUBLIC_SIGNUP_MODE)} />
      </Suspense>
      <DemoAccount email={process.env.NEXT_PUBLIC_DEMO_EMAIL} password={process.env.NEXT_PUBLIC_DEMO_PASSWORD} />
    </div>
  );
}
