"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef, useState } from "react";
import { RequireSignIn } from "@/components/require-sign-in";
import { JournalView } from "@/components/larper-os/journal";
import { clearDemo, setDemo, track } from "@/lib/analytics";
import { describeError, useApi, type JournalEntry, type Me } from "@/lib/api";

const LOAD_FAILED = "try again to reopen your quest history.";

// The larp log: every quest you've been offered, newest first. Downloading and deleting your
// data is in the account window (/account/your-data).
export default function JournalPage() {
  const { isLoaded, userId, sessionId } = useAuth();
  return (
    <RequireSignIn>
      {isLoaded && userId && sessionId && <Journal key={JSON.stringify([userId, sessionId])} />}
    </RequireSignIn>
  );
}

function Journal() {
  const api = useApi();
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const opened = useRef(false);

  useEffect(() => {
    let current = true;
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
    return () => { current = false; };
  }, [api, tries]);

  // Whether this is the demo account, before the visit is recorded.
  useEffect(() => {
    let current = true;
    clearDemo();
    api<Me>("/me").then(
      (m) => {
        if (!current) return;
        if (typeof m?.demo === "boolean") setDemo(m.demo);
      },
      () => {},
    ).then(() => {
      if (!current || opened.current) return;
      opened.current = true;
      track("journal_opened");
    });
    return () => { current = false; };
  }, [api]);

  return <JournalView entries={entries} error={error} retry={() => setTries((n) => n + 1)} />;
}
