import { Suspense } from "react";
import { notFound } from "next/navigation";
import { LarperOsPageShell } from "@/components/larper-os/page-shell";
import { RequireSignIn } from "@/components/require-sign-in";
import { WeeklyEmailPreference } from "./preference";

export default function WeeklyEmailPage() {
  if (process.env.NEXT_PUBLIC_WEEKLY_EMAIL_ENABLED !== "1") notFound();
  return (
    <LarperOsPageShell title="weekly email">
      <Suspense fallback={<p role="status">Loading your preference…</p>}>
        <RequireSignIn><WeeklyEmailPreference /></RequireSignIn>
      </Suspense>
    </LarperOsPageShell>
  );
}
