"use client";

import { useAuth, useClerk } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AccountDeletionComplete, YourData, type AccountKind, type ClerkRemoval } from "@/components/larper-os/your-data";
import { RequireSignIn } from "@/components/require-sign-in";
import { JournalView } from "@/components/larper-os/journal";
import { clearDemo, setDemo, track } from "@/lib/analytics";
import { describeError, useApi, type JournalEntry, type Me } from "@/lib/api";

const LOAD_FAILED = "try again to reopen your quest history.";

type SignOutStatus = "pending" | "failed" | "done";

// The larp log: every quest you've been offered, newest first.
export default function JournalPage() {
  const { isLoaded, userId, sessionId } = useAuth();
  const { signOut } = useClerk();
  const router = useRouter();
  const [completion, setCompletion] = useState<{
    clerkUser: ClerkRemoval;
    sessionId: string;
    status: SignOutStatus;
  } | null>(null);

  async function finishSignOut(clerkUser: ClerkRemoval, deletedSession: string) {
    setCompletion({ clerkUser, sessionId: deletedSession, status: "pending" });
    try {
      // Keep the completion visible through Clerk's auth change. Only leave once signed out.
      await signOut(() => {}, { sessionId: deletedSession });
    } catch {
      setCompletion({ clerkUser, sessionId: deletedSession, status: "failed" });
      return;
    }
    setCompletion({ clerkUser, sessionId: deletedSession, status: "done" });
    if (clerkUser === "deleted") router.replace("/");
  }

  // The signed-in journal must stay unmounted once the purge succeeds, even if sign-out fails.
  if (completion) {
    return (
      <AccountDeletionComplete
        clerkUser={completion.clerkUser}
        status={completion.status}
        onRetry={() => void finishSignOut(completion.clerkUser, completion.sessionId)}
      />
    );
  }

  return (
    <RequireSignIn>
      {isLoaded && userId && sessionId && (
        <Journal
          key={JSON.stringify([userId, sessionId])}
          onAccountDeleted={(clerkUser) => void finishSignOut(clerkUser, sessionId)}
        />
      )}
    </RequireSignIn>
  );
}

function Journal({ onAccountDeleted }: { onAccountDeleted: (clerkUser: ClerkRemoval) => void }) {
  const api = useApi();
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const [account, setAccount] = useState<AccountKind>("checking");
  const [accountDeletePending, setAccountDeletePending] = useState(false);
  const invalidateQuestRequest = useRef<(() => void) | null>(null);
  const opened = useRef(false);

  useEffect(() => {
    let current = true;
    const invalidate = () => { current = false; };
    invalidateQuestRequest.current = invalidate;
    api<JournalEntry[]>("/quests").then(
      (e) => {
        if (!current) return;
        setEntries(e);
        setError(null);
      },
      (e: unknown) => {
        if (!current) return;
        setError(describeError(e, LOAD_FAILED).toLowerCase());
      },
    );
    return invalidate;
  }, [api, tries]);

  // The keyed journal checks eligibility for each auth identity and session.
  useEffect(() => {
    let current = true;
    clearDemo();
    api<Me>("/me").then(
      (m) => {
        if (!current) return;
        if (typeof m?.demo === "boolean") {
          setDemo(m.demo);
          setAccount(m.demo ? "demo" : "user");
        } else {
          setAccount("unknown");
        }
      },
      () => {
        if (current) setAccount("unknown");
      },
    ).then(() => {
      if (!current || opened.current) return;
      opened.current = true;
      track("journal_opened");
    });
    return () => { current = false; };
  }, [api]);

  function reloadQuests() {
    // Invalidate the old response now, before React runs the next request effect.
    invalidateQuestRequest.current?.();
    setTries((n) => n + 1);
  }

  return (
    <JournalView
      entries={entries}
      error={error}
      retry={reloadQuests}
      hideMapLink={accountDeletePending}
      dataPanel={
        <YourData
          account={account}
          onAccountDeleted={onAccountDeleted}
          onAccountDeletePendingChange={setAccountDeletePending}
          onHistoryDeleted={() => {
            reloadQuests();
            setEntries([]);
            setError(null);
          }}
        />
      }
    />
  );
}
