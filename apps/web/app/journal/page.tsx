"use client";

import { YourData, type AccountKind } from "@/components/larper-os/your-data";
import { RequireSignIn } from "@/components/require-sign-in";
import { JournalView } from "@/components/larper-os/journal";
import { useEffect, useRef, useState } from "react";
import { demoFlag, demoKnown, setDemo, track } from "@/lib/analytics";
import { describeError, useApi, type JournalEntry, type Me } from "@/lib/api";

// For calls whose 4xx text is for developers, not people.
const LOAD_FAILED = "try again to reopen your quest history.";

// The larp log: every quest you've been offered, newest first.
export default function JournalPage() {
  return (
    <RequireSignIn>
      <Journal />
    </RequireSignIn>
  );
}

function Journal() {
  const api = useApi();
  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  // Whether this is the shared demo account: it has no data of its own to export or delete.
  const [account, setAccount] = useState<AccountKind>(() => {
    const d = demoFlag();
    return d === undefined ? "checking" : d ? "demo" : "user";
  });

  useEffect(() => {
    api<JournalEntry[]>("/quests").then(
      (e) => {
        setEntries(e);
        setError(null);
      },
      (e: unknown) => setError(describeError(e, LOAD_FAILED).toLowerCase()),
    );
  }, [api, tries]);

  // Recorded once per visit. Coming from the map the demo flag is known; on a fresh load
  // of this page it isn't, so ask /me first. A failed /me only leaves the flag out.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (demoKnown()) {
      track("journal_opened");
      return;
    }
    api<Me>("/me")
      .then(
        (m) => {
          setDemo(!!m.demo);
          setAccount(m.demo ? "demo" : "user");
        },
        () => setAccount("unknown"),
      )
      .then(() => track("journal_opened"));
  }, [api]);

  return (
    <JournalView
      entries={entries}
      error={error}
      retry={() => setTries((n) => n + 1)}
      dataPanel={
        <YourData
          account={account}
          onHistoryDeleted={() => {
            // Nothing stale: empty the list now, then ask the API again.
            setEntries([]);
            setTries((n) => n + 1);
          }}
        />
      }
    />
  );
}
