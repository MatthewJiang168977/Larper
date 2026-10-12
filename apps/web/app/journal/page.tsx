"use client";

import Link from "next/link";
import { RequireSignIn } from "@/components/require-sign-in";
import { useEffect, useState } from "react";
import { useApi, type JournalEntry } from "@/lib/api";

const STAMP: Record<JournalEntry["status"], { label: string; cls: string }> = {
  completed: { label: "Done", cls: "border-moss text-moss" },
  accepted: { label: "On it", cls: "border-oxblood text-oxblood" },
  offered: { label: "Offered", cls: "border-ink-faint text-ink-soft" },
  skipped: { label: "Skipped", cls: "border-ink-faint text-ink-faint line-through" },
  expired: { label: "Expired", cls: "border-ink-faint text-ink-faint" },
};

const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

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

  useEffect(() => {
    api<JournalEntry[]>("/quests").then(setEntries, (e: Error) => setError(e.message));
  }, [api]);

  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-8">
      <Link href="/" className="font-mono text-xs uppercase tracking-wider text-ink-soft underline-offset-4 hover:underline">
        ← Map
      </Link>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight">Field journal</h1>
      <p className="mt-1 text-ink-soft">Every quest you&apos;ve been handed.</p>

      {error && <p role="alert" className="mt-6 text-oxblood">{error}</p>}
      {!entries && !error && <p className="field-label mt-8">Opening the journal…</p>}
      {entries?.length === 0 && <p className="mt-8 text-ink-soft">Blank pages. Your first quest is on the map.</p>}

      <ol className="mt-6 divide-y divide-rule border-y border-rule">
        {entries?.map((e) => (
          <li key={e.id} className="flex items-start gap-4 py-4">
            <span className="field-label w-14 shrink-0 pt-1">{fmt.format(new Date(e.createdAt))}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-lg font-medium">{e.name}</p>
              <p className="text-sm text-ink-soft">
                {e.category.replaceAll("_", " ")}
                {e.reasons.liked.length > 0 && ` · for ${e.reasons.liked.slice(0, 2).join(" + ")}`}
              </p>
            </div>
            <span className={`shrink-0 -rotate-3 rounded border-2 px-2 py-0.5 font-mono text-xs uppercase ${STAMP[e.status].cls}`}>
              {STAMP[e.status].label}
            </span>
          </li>
        ))}
      </ol>
    </main>
  );
}
