import { ClerkLoading } from "@clerk/nextjs";
import { Suspense } from "react";
import { AccountWindow } from "@/components/auth/account-window";
import { LarperOsPageShell } from "@/components/larper-os/page-shell";
import { RequireSignIn } from "@/components/require-sign-in";

// Clerk's profile reads the URL (path routing) at request time, which can't be part of
// the prerendered shell under Cache Components: the shell prerenders, the profile streams in.
export default function AccountPage() {
  return (
    <LarperOsPageShell title="account" wide>
      <ClerkLoading>
        <p role="status">loading your account…</p>
      </ClerkLoading>
      <Suspense fallback={null}>
        <RequireSignIn><AccountWindow /></RequireSignIn>
      </Suspense>
    </LarperOsPageShell>
  );
}
