import Link from "next/link";
import type { ReactNode } from "react";
import { larperOsClassName } from "@/app/larper-os";
import { humanize } from "@/components/quest/why-lines";
import type { JournalEntry } from "@/lib/api";
import { OSButton, OSMenuBar, OSQuestPanel, OSWindow } from "./primitives";
import "./journal.css";

const stamp: Record<JournalEntry["status"], string> = {
  completed: "done",
  accepted: "on it",
  offered: "today",
  skipped: "skipped",
  expired: "expired",
};

// Match the API's quest day, including when the viewer is in a different timezone.
const journalDate = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", timeZone: "America/New_York",
});
const errorTitle = "couldn't open the journal";

export function JournalView({ entries, error, retry, previewControls, mapHref = "/" }: {
  entries: JournalEntry[] | null;
  error: string | null;
  retry: () => void;
  previewControls?: ReactNode;
  mapHref?: string;
}) {
  const count = entries?.length;
  const footer = error ? errorTitle : count === undefined ? "opening the journal…" : `${count} ${count === 1 ? "file" : "files"}`;

  return (
    <main className={`${larperOsClassName} larper-journal`}>
      <OSMenuBar>{previewControls}</OSMenuBar>
      <div className="larper-journal-stage">
        <OSWindow title="quest journal" footer={footer}>
          <div className="larper-journal-heading">
            <h1>field journal</h1>
            <p>every quest you&apos;ve been handed.</p>
          </div>

          {error && (
            <OSQuestPanel role="alert">
              <h2 className="larper-journal-name">{errorTitle}</h2>
              <p>{error}</p>
              <div className="larper-journal-retry">
                <OSButton primary onClick={retry}>try again</OSButton>
              </div>
            </OSQuestPanel>
          )}
          {!entries && !error && (
            <OSQuestPanel role="status">opening the journal…</OSQuestPanel>
          )}
          {count === 0 && (
            <OSQuestPanel>blank pages. your first quest is on the map.</OSQuestPanel>
          )}
          {!!count && (
            <OSQuestPanel>
              <ol className="larper-journal-list" role="list" aria-label="quest history">
                {entries?.map((entry) => (
                  <li key={entry.id} className="larper-journal-row">
                    <div className="larper-journal-file">
                      <svg viewBox="0 0 24 28" width="20" height="24" fill="none" stroke="currentColor"
                        strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4 2h10l6 6v18H4zM14 2v6h6M8 13h8M8 17h8M8 21h5" />
                      </svg>
                      <div>
                        <p className="larper-journal-name">{entry.name}</p>
                        <p className="larper-journal-detail">
                          {humanize(entry.category)}
                          {entry.reasons.liked.length > 0 && ` · for ${entry.reasons.liked.slice(0, 2).map(humanize).join(" + ")}`}
                        </p>
                        {entry.status === "completed" && entry.simulated && (
                          <p className="larper-journal-detail">Simulated check-in · demo account</p>
                        )}
                      </div>
                    </div>
                    <div className="larper-journal-meta">
                      <time dateTime={entry.createdAt}>{journalDate.format(new Date(entry.createdAt)).toLowerCase()}</time>
                      <span className="larper-journal-stamp" data-state={entry.status}>{stamp[entry.status]}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </OSQuestPanel>
          )}
          <Link href={mapHref} className="larper-os-button larper-journal-back">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5m6-6-6 6 6 6" />
            </svg>
            back to the map
          </Link>
        </OSWindow>
      </div>
    </main>
  );
}
