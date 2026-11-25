"use client";

// The account window's contents: Clerk's own profile and security pages, plus Larper's "your
// data" and "weekly email" as pages inside it. This sits in app/account/layout.tsx, above the
// tabs' routes, so an account deletion finishes even if the visitor switches tab while it runs.
import { SignOutButton, useAuth, useClerk, UserProfile, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { WeeklyEmailPreference } from "@/app/account/weekly-email/preference";
import {
  AccountDeletionCompleteBody, NO_PRIVACY, privacyFrom, SignInRemovalFailedBody, type ClerkRemoval,
} from "@/components/larper-os/your-data";
import { OSButton, osPrimaryButtonClass } from "@/components/larper-os/primitives";
import { RequireSignIn } from "@/components/require-sign-in";
import { clearDemo, setDemo } from "@/lib/analytics";
import { useApi, type Me, type Privacy } from "@/lib/api";
import { AccountDataPage } from "./account-data-page";
import { userProfileAppearance } from "./clerk-appearance";

type After = { sessionId: string; step: "removal-failed" | "signing-out" | "failed" | "done" };

export function AccountWindow() {
  const { isLoaded, userId, sessionId } = useAuth();
  const { signOut } = useClerk();
  const router = useRouter();
  const [after, setAfter] = useState<After | null>(null);
  const currentSession = useRef(sessionId);
  useEffect(() => { currentSession.current = sessionId; }, [sessionId]);

  async function finishSignOut(deletedSession: string) {
    setAfter({ sessionId: deletedSession, step: "signing-out" });
    try {
      // Keep the completion visible through Clerk's auth change. Only leave once signed out.
      await signOut(() => {}, { sessionId: deletedSession });
    } catch {
      setAfter({ sessionId: deletedSession, step: "failed" });
      return;
    }
    setAfter({ sessionId: deletedSession, step: "done" });
    router.replace("/");
  }

  // The data is gone: nothing of the account is shown again, even if sign-out fails.
  if (after && after.step !== "removal-failed") {
    return (
      <AccountDeletionCompleteBody
        status={after.step === "signing-out" ? "pending" : after.step}
        onRetry={() => void finishSignOut(after.sessionId)}
      />
    );
  }

  if (after && after.sessionId === sessionId) {
    return (
      <RequireSignIn>
        <SignInRemovalFailedBody onRemoved={() => void finishSignOut(after.sessionId)} />
      </RequireSignIn>
    );
  }

  return (
    <RequireSignIn>
      {isLoaded && userId && sessionId ? (
        <Account
          key={JSON.stringify([userId, sessionId])}
          onAccountDeleted={(clerkUser) => {
            // A reply for a session the visitor has since switched away from.
            if (currentSession.current && currentSession.current !== sessionId) return;
            if (clerkUser === "deleted") void finishSignOut(sessionId);
            else setAfter({ sessionId, step: "removal-failed" });
          }}
        />
      ) : (
        <p role="status">loading your account…</p>
      )}
    </RequireSignIn>
  );
}

type Kind =
  | { is: "checking" }
  | { is: "unknown" }
  | { is: "demo" }
  | { is: "user"; privacy: Privacy };

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d={d} />
  </svg>
);
const DATA_ICON = icon("M12 4c4.4 0 8 1.1 8 2.5S16.4 9 12 9 4 7.9 4 6.5 7.6 4 12 4zM4 6.5v11C4 18.9 7.6 20 12 20s8-1.1 8-2.5v-11");
const MAIL_ICON = icon("M3 5h18v14H3zM4 7l8 6 8-6");

function SignOut() {
  return (
    <div className="larper-account-signout">
      <SignOutButton><OSButton>sign out</OSButton></SignOutButton>
      <span>clerk keeps your sign-in.</span>
    </div>
  );
}

function Account({ onAccountDeleted }: { onAccountDeleted: (clerkUser: ClerkRemoval) => void }) {
  const api = useApi();
  const { user } = useUser();
  const [kind, setKind] = useState<Kind>({ is: "checking" });
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let current = true;
    clearDemo();
    api<Me>("/me").then(
      (m) => {
        if (!current) return;
        if (typeof m?.demo !== "boolean") return setKind({ is: "unknown" });
        setDemo(m.demo);
        setKind(m.demo ? { is: "demo" } : { is: "user", privacy: m.privacy ? privacyFrom(m.privacy) : NO_PRIVACY });
      },
      () => { if (current) setKind({ is: "unknown" }); },
    );
    return () => { current = false; };
  }, [api, tries]);

  if (kind.is === "checking") return <p role="status">checking your account…</p>;
  // Until /me says this isn't the shared demo account, none of Clerk's forms are offered.
  if (kind.is === "unknown") {
    return (
      <>
        <p role="alert">couldn&apos;t check your account.</p>
        <div className="larper-data-actions">
          <OSButton primary onClick={() => { setKind({ is: "checking" }); setTries((n) => n + 1); }}>try again</OSButton>
        </div>
        <SignOut />
      </>
    );
  }
  if (kind.is === "demo") {
    return (
      <>
        <p>the shared demo account has no settings of its own.</p>
        <div className="larper-data-actions">
          <Link href="/" className={osPrimaryButtonClass}>back to larper</Link>
        </div>
        <SignOut />
      </>
    );
  }
  return (
    <>
      <UserProfile routing="path" path="/account" appearance={userProfileAppearance(user)}>
        <UserProfile.Page label="account" />
        <UserProfile.Page label="security" />
        <UserProfile.Page label="your data" url="your-data" labelIcon={DATA_ICON}>
          <AccountDataPage privacy={kind.privacy} onAccountDeleted={onAccountDeleted} />
        </UserProfile.Page>
        {process.env.NEXT_PUBLIC_WEEKLY_EMAIL_ENABLED === "1" && (
          <UserProfile.Page label="weekly email" url="weekly-email" labelIcon={MAIL_ICON}>
            <div className="larper-account-page">
              <h2 className="larper-journal-name">weekly email</h2>
              <WeeklyEmailPreference />
            </div>
          </UserProfile.Page>
        )}
      </UserProfile>
      <SignOut />
    </>
  );
}
