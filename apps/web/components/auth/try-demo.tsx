"use client";

// "Try the demo": a one-time sign-in token for the shared account (./demo-account.ts).
import { useSignIn } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, demoTicket, describeError } from "@/lib/api";
import { demoEnabled } from "./demo-account";

/** What to tell a visitor when the demo didn't start. */
export function demoError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return "The demo isn't available here.";
    if (e.status === 429) return e.retryAfterS
      ? `Lots of demo sign-ins just now. Try again in ${e.retryAfterS} s.`
      : "Lots of demo sign-ins just now. Try again in a minute.";
    return describeError(e);
  }
  return "Couldn't start the demo. Try again.";
}

export function TryDemoButton({ className, redirectTo = "/" }: { className?: string; redirectTo?: string }) {
  const { signIn } = useSignIn();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const ticket = await demoTicket();
      const signedIn = await signIn.ticket({ ticket });
      if (signedIn.error) throw signedIn.error;
      if (signIn.status !== "complete") throw new Error(`demo sign-in is ${signIn.status}`);
      const done = await signIn.finalize({
        navigate: ({ decorateUrl }) => {
          const url = decorateUrl(redirectTo);
          if (url.startsWith("http")) window.location.href = url;
          else router.push(url);
        },
      });
      if (done.error) throw done.error;
    } catch (e) {
      setError(demoError(e));
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-center gap-2">
      <button type="button" className={className} onClick={start} disabled={busy} aria-busy={busy}>
        {busy ? "Starting the demo…" : "Try the demo"}
      </button>
      {error && (
        <span role="alert" className="max-w-xs text-sm text-oxblood">
          {error}
        </span>
      )}
    </span>
  );
}

// On the sign-in page, under Clerk's form, for visitors without an invitation.
export function DemoPanel({ signUpMode }: { signUpMode: string | undefined }) {
  if (!demoEnabled(signUpMode)) return null;
  return (
    <section aria-label="Demo" className="flex w-full max-w-sm flex-col items-center gap-2 rounded border border-rule bg-paper px-4 py-3 text-center text-sm">
      <p className="field-label">Just looking?</p>
      <p>Sign-ups are by invitation. Look around with the shared demo account, no password needed.</p>
      <TryDemoButton className="stamp-btn rounded-md bg-oxblood px-4 py-2 text-paper" />
      <p className="text-xs text-ink-label">Everyone shares it, and it&apos;s reset every night.</p>
    </section>
  );
}
