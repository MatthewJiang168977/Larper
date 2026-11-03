"use client";

import Link from "next/link";
import { RequireSignIn } from "@/components/require-sign-in";
import { humanize } from "@/components/quest/why-lines";
import { useEffect, useState } from "react";
import { describeError, useApi, type JournalEntry } from "@/lib/api";

const STAMP: Record<JournalEntry["status"], { label: string; cls: string }> = {
  completed: { label: "Done", cls: "border-moss text-moss" },
  accepted: { label: "On it", cls: "border-oxblood text-oxblood" },
  // An offer is only ever today's quest (an old one expires), so it says so, in oxblood.
  offered: { label: "Today", cls: "border-oxblood text-oxblood" },
  skipped: { label: "Skipped", cls: "border-ink-faint text-ink-label line-through" },
  expired: { label: "Expired", cls: "border-ink-faint text-ink-label" },
};

// Dates in New York time, as the API's day is (DAY_TIME_ZONE): a quest from late on the
// 24th reads the 24th on every device, wherever it is.
const journalDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

// For calls whose 4xx text is for developers, not people.
const LOAD_FAILED = "Couldn't open the journal.";

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

  useEffect(() => {
    api<JournalEntry[]>("/quests").then(
      (e) => {
        setEntries(e);
        setError(null);
      },
      (e: unknown) => setError(describeError(e, LOAD_FAILED)),
    );
  }, [api, tries]);

  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-8">
      <Link href="/" className="hit-target font-mono text-xs uppercase tracking-wider text-ink-soft underline-offset-4 hover:underline">
        ← Map
      </Link>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight">Field journal</h1>
      <p className="mt-1 text-ink-soft">Every quest you&apos;ve been handed.</p>

      {error && (
        <div role="alert" className="mt-6 rounded border border-oxblood px-3 py-2 text-oxblood">
          <p className="field-label text-oxblood">Couldn&apos;t open the journal</p>
          <p className="mt-0.5">{error}</p>
          <button onClick={() => setTries((n) => n + 1)} className="hit-target mt-1 font-medium underline">
            Try again
          </button>
        </div>
      )}
      {!entries && !error && (
        <p role="status" className="field-label mt-8">
          Opening the journal…
        </p>
      )}
      {entries?.length === 0 && <p className="mt-8 text-ink-soft">Blank pages. Your first quest is on the map.</p>}

      {/* No rules around an empty list: blank pages are blank. */}
      {!!entries?.length && (
        <ol className="mt-6 divide-y divide-rule border-y border-rule">
          {entries.map((e) => (
            <li key={e.id} className="flex items-start gap-4 py-4">
              <span className="field-label w-14 shrink-0 pt-1">{journalDate.format(new Date(e.createdAt))}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-lg font-medium">{e.name}</p>
                <p className="text-sm text-ink-soft">
                  {humanize(e.category)}
                  {e.reasons.liked.length > 0 && ` · for ${e.reasons.liked.slice(0, 2).map(humanize).join(" + ")}`}
                </p>
                {/* The demo account "arrives" from anywhere (quests.service checkGeofence):
                    its journal says which check-ins were pretend. */}
                {e.status === "completed" && e.simulated && (
                  <p className="field-label mt-1">Simulated check-in · demo account</p>
                )}
              </div>
              <span className={`shrink-0 -rotate-3 rounded border-2 px-2 py-0.5 font-mono text-xs uppercase ${STAMP[e.status].cls}`}>
                {STAMP[e.status].label}
              </span>
            </li>
          ))}
        </ol>
      )}

      {entries && (
        <Link href="/" className="stamp-btn mt-8 inline-flex min-h-11 items-center rounded-md bg-paper px-4 py-2">
          ← Back to the map
        </Link>
      )}
    </main>
  );
}
