"use client";

// "your data" inside the account window: the same download / delete history / delete
// account controls as the journal (YourData), same endpoints, same in-page confirmations,
// and the same demo protection (the demo account sees no controls).
import { useAuth, useClerk } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  AccountDeletionCompleteBody, NO_PRIVACY, privacyFrom, SignInRemovalFailedBody, YourData,
  type AccountKind, type ClerkRemoval,
} from "@/components/larper-os/your-data";
import { useApi, type Me, type Privacy } from "@/lib/api";

type After = { sessionId: string; step: "removal-failed" } | { sessionId: string; step: "signing-out" | "failed" | "done" };

export function AccountDataPage() {
  const api = useApi();
  const { sessionId } = useAuth();
  const { signOut } = useClerk();
  const router = useRouter();
  const [account, setAccount] = useState<AccountKind>("checking");
  const [privacy, setPrivacy] = useState<Privacy>(NO_PRIVACY);
  const [after, setAfter] = useState<After | null>(null);

  useEffect(() => {
    let current = true;
    api<Me>("/me").then(
      (m) => {
        if (!current) return;
        if (typeof m?.demo === "boolean") {
          setPrivacy(m.demo ? NO_PRIVACY : privacyFrom(m.privacy));
          setAccount(m.demo ? "demo" : "user");
        } else setAccount("unknown");
      },
      () => { if (current) setAccount("unknown"); },
    );
    return () => { current = false; };
  }, [api]);

  async function finishSignOut(id: string) {
    setAfter({ sessionId: id, step: "signing-out" });
    try {
      await signOut(() => {}, { sessionId: id });
    } catch {
      setAfter({ sessionId: id, step: "failed" });
      return;
    }
    setAfter({ sessionId: id, step: "done" });
    router.replace("/");
  }

  if (after?.step === "removal-failed") {
    return <SignInRemovalFailedBody onRemoved={() => void finishSignOut(after.sessionId)} />;
  }
  if (after) {
    const status = after.step === "signing-out" ? "pending" : after.step;
    return <AccountDeletionCompleteBody status={status} onRetry={() => void finishSignOut(after.sessionId)} />;
  }

  return (
    <YourData
      account={account}
      privacy={privacy}
      onAccountDeleted={(clerkUser: ClerkRemoval) => {
        if (!sessionId) return;
        if (clerkUser === "deleted") void finishSignOut(sessionId);
        else setAfter({ sessionId, step: "removal-failed" });
      }}
      onAccountDeletePendingChange={() => {}}
      onHistoryDeleted={() => {}}
    />
  );
}
