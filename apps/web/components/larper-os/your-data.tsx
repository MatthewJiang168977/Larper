"use client";

import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, describeError, useApi } from "@/lib/api";
import { larperOsClassName } from "@/app/larper-os";
import { OSButton, OSMenuBar, OSQuestPanel, OSWindow, osPrimaryButtonClass } from "./primitives";
import "./your-data.css";

/** "checking": /me hasn't answered. "unknown": it failed, so we can't tell if this is the demo. */
export type AccountKind = "checking" | "user" | "demo" | "unknown";

export type ClerkRemoval = "manual" | "deleted" | "failed";

const CONFIRM_WORD = "delete";

interface HistoryDeleted {
  deleted: { quests: number; checkInAttempts: number; hoursAnswers: number; savedPlaces: number; events: number };
}
interface AccountDeleted {
  deleted: HistoryDeleted["deleted"] & { tasteProfile: boolean; account: boolean };
  clerkUser: ClerkRemoval;
}

type Kind = "history" | "account";

const COPY: Record<Kind, { open: string; title: string; deletes: string[]; keeps?: string[]; confirm: string }> = {
  history: {
    open: "delete my history",
    title: "delete your history?",
    deletes: [
      "your journal: every quest you've been offered.",
      "your check-ins, including the attempts that didn't count.",
      "your answers to “was it open?”.",
      "your saved places.",
    ],
    keeps: [
      "your account and sign-in.",
      "your taste profile: what you told larper you like. quests carry on from there.",
    ],
    confirm: "delete my history",
  },
  account: {
    open: "delete my account",
    title: "delete your account?",
    deletes: [
      "everything in “delete my history”: your journal, check-ins, “was it open?” answers and saved places.",
      "your taste profile.",
      "your larper account.",
    ],
    confirm: "delete my account",
  },
};

const BACKUPS =
  "deleting can't be undone from the app. copies can stay for about 3 weeks under the usual backup schedule. backup storage has a 60-day cleanup rule for old objects. restoring a backup could bring deleted data back.";
const BROKER_RETENTION =
  "events already sent to our event broker can stay after deletion. closed segments are eligible for cleanup after about 7 days, with no fixed deadline.";

function countLine(d: HistoryDeleted["deleted"]): string {
  const n = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`;
  return `deleted ${n(d.quests, "quest", "quests")}, ${n(d.checkInAttempts, "check-in attempt", "check-in attempts")}, ${n(
    d.hoursAnswers,
    "“was it open?” answer",
    "“was it open?” answers",
  )} and ${n(d.savedPlaces, "saved place", "saved places")}.`;
}

const exportName = () => `larper-export-${new Date().toISOString().slice(0, 10)}.json`;

/** Plain words for a failed export or delete. */
function failure(e: unknown): string {
  if (e instanceof ApiError && e.status === 403 && e.code === "demo_account") {
    return "the shared demo account has no data of its own to download or delete.";
  }
  if (e instanceof ApiError && e.status === 429) {
    const s = e.retryAfterS;
    const wait = s ? ` wait about ${s < 90 ? `${Math.ceil(s)} seconds` : `${Math.ceil(s / 60)} minutes`} and try again.` : " wait a bit and try again.";
    return `that's too many tries in a row.${wait}`;
  }
  return describeError(e, "that didn't work. try again.").toLowerCase();
}

export function YourData({ account, onHistoryDeleted, onAccountDeleted }: {
  account: AccountKind;
  onHistoryDeleted: () => void;
  onAccountDeleted: (clerkUser: ClerkRemoval) => void;
}) {
  const api = useApi();
  const headingId = useId();
  const [downloading, setDownloading] = useState(false);
  const [downloadMsg, setDownloadMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [asking, setAsking] = useState<Kind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletePending = useRef(false);
  const active = useRef(false);
  const historyButton = useRef<HTMLButtonElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const lastAsked = useRef<Kind | null>(null);

  // Ignore action replies after the journal has switched auth sessions or been closed.
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  // Closing a confirmation puts focus back on the button that opened it.
  useEffect(() => {
    if (asking === null && lastAsked.current) {
      (lastAsked.current === "history" ? historyButton : accountButton).current?.focus();
      lastAsked.current = null;
    }
  }, [asking]);

  async function download() {
    setDownloading(true);
    setDownloadMsg(null);
    try {
      const data = await api<unknown>("/me/export");
      if (!active.current) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = exportName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDownloadMsg({ ok: true, text: `saved ${a.download}.` });
    } catch (e) {
      setDownloadMsg({ ok: false, text: failure(e) });
    } finally {
      setDownloading(false);
    }
  }

  function ask(kind: Kind) {
    if (asking || downloading || deletePending.current) return;
    setNotice(null);
    setDownloadMsg(null);
    lastAsked.current = kind;
    setAsking(kind);
  }

  async function runDelete(kind: Kind) {
    if (deletePending.current) return;
    deletePending.current = true;
    setDeleting(true);
    try {
      if (kind === "history") {
        const r = await api<HistoryDeleted>("/me/history", { method: "DELETE" });
        if (!active.current) return;
        onHistoryDeleted();
        setNotice(countLine(r.deleted));
        setAsking(null);
      } else {
        const r = await api<AccountDeleted>("/me", { method: "DELETE" });
        if (active.current) onAccountDeleted(r.clerkUser);
      }
    } finally {
      deletePending.current = false;
      setDeleting(false);
    }
  }

  const actionsLocked = asking !== null || downloading;
  let body: ReactNode;
  if (account === "checking") {
    body = <p role="status">checking your account…</p>;
  } else if (account === "unknown") {
    body = <p>couldn&apos;t check your account. reload the page to see your data options.</p>;
  } else if (account === "demo") {
    body = <p>the shared demo account has no data of its own to download or delete.</p>;
  } else {
    body = (
      <>
        <p>download a copy of your larper records, or delete your history or account.</p>
        <div className="larper-data-actions">
          <OSButton onClick={download} disabled={actionsLocked} aria-busy={downloading}>
            {downloading ? "preparing…" : "download my data"}
          </OSButton>
          <OSButton ref={historyButton} onClick={() => ask("history")} disabled={actionsLocked} aria-expanded={asking === "history"}>
            {COPY.history.open}
          </OSButton>
          <OSButton ref={accountButton} onClick={() => ask("account")} disabled={actionsLocked} aria-expanded={asking === "account"}>
            {COPY.account.open}
          </OSButton>
        </div>
        <p className="larper-data-status" role="status">
          {downloadMsg && <span data-ok={downloadMsg.ok}>{downloadMsg.text}</span>}
          {notice}
        </p>
        {asking && (
          <Confirm
            key={asking}
            kind={asking}
            busy={deleting}
            onCancel={() => {
              if (!deletePending.current) setAsking(null);
            }}
            run={() => runDelete(asking)}
          />
        )}
      </>
    );
  }

  return (
    <OSQuestPanel>
      <section className="larper-data" aria-labelledby={headingId}>
        <h2 id={headingId} className="larper-journal-name">your data</h2>
        {body}
      </section>
    </OSQuestPanel>
  );
}

export function AccountDeletionComplete({ clerkUser, status, onRetry }: {
  clerkUser: ClerkRemoval;
  status: "pending" | "failed" | "done";
  onRetry: () => void;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);

  return (
    <main className={`${larperOsClassName} larper-journal`}>
      <OSMenuBar />
      <div className="larper-journal-stage">
        <OSWindow title="your data">
          <OSQuestPanel>
            <div className="larper-data">
              <div role="status">
                <h1 ref={ref} tabIndex={-1} className="larper-journal-name">your larper data is deleted.</h1>
                {clerkUser === "manual" && <p>larper didn&apos;t remove your clerk sign-in.</p>}
                {clerkUser === "failed" && <p>larper couldn&apos;t remove your clerk sign-in.</p>}
                {status === "pending" && <p>signing out…</p>}
                {status === "done" && <p>you&apos;re signed out.</p>}
              </div>
              {status === "failed" && (
                <>
                  <p role="alert">couldn&apos;t sign you out. try signing out again.</p>
                  <div className="larper-data-actions">
                    <OSButton primary onClick={onRetry}>retry sign-out</OSButton>
                  </div>
                </>
              )}
              {status === "done" && (
                <div className="larper-data-actions">
                  <Link href="/" replace className={osPrimaryButtonClass}>back to larper</Link>
                </div>
              )}
            </div>
          </OSQuestPanel>
        </OSWindow>
      </div>
    </main>
  );
}

function Confirm({ kind, busy, onCancel, run }: {
  kind: Kind;
  busy: boolean;
  onCancel: () => void;
  run: () => Promise<void>;
}) {
  const copy = COPY[kind];
  const titleId = useId();
  const inputId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const armed = typed.trim().toLowerCase() === CONFIRM_WORD;

  // Focus moves into the confirmation when it opens.
  useEffect(() => ref.current?.focus(), []);

  async function go() {
    if (!armed || busy) return;
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(failure(e));
    }
  }

  // After a failure the inputs are enabled again: put focus back on the field.
  useEffect(() => {
    if (error) input.current?.focus();
  }, [error]);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-labelledby={titleId}
      className="larper-data-confirm"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) onCancel();
      }}
    >
      <h3 id={titleId} className="larper-journal-name">{copy.title}</h3>
      <p>this deletes:</p>
      <ul>{copy.deletes.map((d) => <li key={d}>{d}</li>)}</ul>
      {copy.keeps && (
        <>
          <p>this keeps:</p>
          <ul>{copy.keeps.map((d) => <li key={d}>{d}</li>)}</ul>
        </>
      )}
      {kind === "account" && <p>larper tries to remove your sign-in with clerk when it can, then tries to sign you out.</p>}
      <p>{BACKUPS}</p>
      <p>{BROKER_RETENTION}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <label htmlFor={inputId}>type &ldquo;{CONFIRM_WORD}&rdquo; to go ahead</label>
        <input
          id={inputId}
          ref={input}
          className="larper-data-input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          disabled={busy}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
        />
        <div className="larper-data-actions">
          <OSButton type="submit" primary disabled={!armed || busy} aria-busy={busy}>
            {busy ? "deleting…" : copy.confirm}
          </OSButton>
          <OSButton onClick={onCancel} disabled={busy}>cancel</OSButton>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
