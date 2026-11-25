"use client";

// "try the demo": a one-time sign-in token for the shared account (./demo-account.ts).
import { useSignIn } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { OSWindow } from "@/components/larper-os/primitives";
import { setDemo, track } from "@/lib/analytics";
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

export function TryDemoButton({
  className,
  redirectTo = "/",
  labels = { idle: "try the demo", busy: "starting the demo…" },
}: {
  className?: string;
  redirectTo?: string;
  labels?: { idle: string; busy: string };
}) {
  const { signIn } = useSignIn();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    // Not signed in yet, so not the demo account (this button is also on /sign-in).
    setDemo(false);
    track("demo_clicked");
    try {
      const ticket = await demoTicket();
      const signedIn = await signIn.ticket({ ticket });
      if (signedIn.error) throw signedIn.error;
      if (signIn.status !== "complete") throw new Error(`demo sign-in is ${signIn.status}`);
      const done = await signIn.finalize({
        navigate: ({ decorateUrl }) => {
          // Signed in: recorded before leaving the page. "demo signed in" is the main
          // count of people trying Larper.
          setDemo(true);
          track("demo_signed_in");
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
        {busy ? labels.busy : labels.idle}
      </button>
      {error && (
        <span role="alert" className="max-w-xs text-sm text-oxblood">
          {error}
        </span>
      )}
    </span>
  );
}

// For visitors without an invitation. Cream, not pool: sign-in's "continue" is the primary.
function Demo({ text }: { text: string }) {
  return (
    <section aria-label="demo" className="larper-os-auth-demo">
      <p>{text}</p>
      <TryDemoButton className="larper-os-button" />
    </section>
  );
}

/** Under Clerk's form, on a phone. */
export function DemoPanel({ signUpMode }: { signUpMode: string | undefined }) {
  if (!demoEnabled(signUpMode)) return null;
  return <Demo text="just looking? the shared demo needs no password. everyone shares it." />;
}

/** Its own window beside sign-in, on a wide screen. */
export function DemoWindow() {
  return (
    <OSWindow title="just_looking.txt">
      <Demo text="look around with the shared demo account. no password needed. everyone shares it." />
    </OSWindow>
  );
}
