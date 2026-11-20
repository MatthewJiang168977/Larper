"use client";

import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, describeError, useApi, type Privacy } from "@/lib/api";
import { larperOsClassName } from "@/app/larper-os";
import { OSButton, OSMenuBar, OSQuestPanel, OSWindow, osPrimaryButtonClass } from "./primitives";
import "./your-data.css";

/** "checking": /me hasn't answered. "unknown": it failed, so we can't tell if this is the demo. */
export type AccountKind = "checking" | "user" | "demo" | "unknown";

/** What DELETE /me says about the sign-in: removed, or the data is gone but the sign-in isn't. */
export type ClerkRemoval = "deleted" | "failed";

export const NO_PRIVACY: Privacy = { export: false, deleteHistory: false, deleteAccount: false };

/** A /me reply's privacy flags, with anything missing or not exactly true counted as off. */
export function privacyFrom(p: Partial<Privacy> | undefined | null): Privacy {
  return { export: p?.export === true, deleteHistory: p?.deleteHistory === true, deleteAccount: p?.deleteAccount === true };
}

const REVOKE_DELAY_MS = 1000;

/**
 * The API says "Clerk has no such user" with a 401 carrying code account_gone; that, and only
 * that, means the account is already deleted. Every other 401 (no token, a token that fails
 * verification) is a session problem: nothing was deleted, and saying so would be false.
 */
const accountAlreadyGone = (e: unknown) => e instanceof ApiError && e.status === 401 && e.code === "account_gone";

const UNAVAILABLE = "deleting your data isn't available yet.";

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
      "your taste profile: what you told larper you like, and what it has learned from your quests. quests carry on from there.",
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
      "your sign-in.",
    ],
    confirm: "delete my account",
  },
};

const BACKUPS =
  "deleting can't be undone from the app. copies can stay for about 3 weeks under the usual backup schedule. backup storage has a 60-day cleanup rule for old objects. restoring a backup could bring deleted data back.";
const BROKER_RETENTION =
  "events already sent to our event broker can stay after deletion until its scheduled cleanup, with no fixed deadline.";
const NEW_ACCOUNT = "you can sign up again later, but it will be a new account with none of this in it.";

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
  if (e instanceof ApiError && e.status === 503 && e.code === "deletes_unavailable") return UNAVAILABLE;
  if (e instanceof ApiError && e.status === 429) {
    const s = e.retryAfterS;
    const wait = s ? ` wait about ${s < 90 ? `${Math.ceil(s)} seconds` : `${Math.ceil(s / 60)} minutes`} and try again.` : " wait a bit and try again.";
    return `that's too many tries in a row.${wait}`;
  }
  return describeError(e, "that didn't work. try again.").toLowerCase();
}

/** The sentence above the buttons: only names what is actually offered. */
function intro(p: Privacy): string {
  if (!p.deleteHistory && !p.deleteAccount) return `${UNAVAILABLE} you can still download it.`;
  const parts = [p.export && "download a copy of your larper records", p.deleteHistory && "delete your history", p.deleteAccount && "delete your account"].filter(
    (x): x is string => !!x,
  );
  return `${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}` : parts[0]}.`;
}

export function YourData({ account, privacy = NO_PRIVACY, onHistoryDeleted, onAccountDeleted, onAccountDeletePendingChange }: {
  account: AccountKind;
  /** What /me says is switched on. Only read for a signed-in, non-demo account. */
  privacy?: Privacy;
  onHistoryDeleted: () => void;
  onAccountDeleted: (clerkUser: ClerkRemoval) => void;
  onAccountDeletePendingChange: (pending: boolean) => void;
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
      // Not at once: iOS Safari can still be reading the blob when the click returns.
      setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
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
    if (kind === "account") onAccountDeletePendingChange(true);
    try {
      if (kind === "history") {
        const r = await api<HistoryDeleted>("/me/history", { method: "DELETE" });
        if (!active.current) return;
        onHistoryDeleted();
        setNotice(countLine(r.deleted));
        setAsking(null);
      } else {
        let clerkUser: ClerkRemoval;
        try {
          clerkUser = (await api<AccountDeleted>("/me", { method: "DELETE" })).clerkUser;
        } catch (e) {
          if (!accountAlreadyGone(e)) throw e;
          clerkUser = "deleted";
        }
        if (active.current) onAccountDeleted(clerkUser);
      }
    } catch (e) {
      // On success the completion screen takes over with the map link still hidden.
      if (kind === "account" && active.current) onAccountDeletePendingChange(false);
      throw e;
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
  } else if (!privacy.export && !privacy.deleteHistory && !privacy.deleteAccount) {
    body = <p>downloading or deleting your data isn&apos;t available yet.</p>;
  } else {
    body = (
      <>
        <p>{intro(privacy)}</p>
        <div className="larper-data-actions">
          {privacy.export && (
            <OSButton onClick={download} disabled={actionsLocked} aria-busy={downloading}>
              {downloading ? "preparing…" : "download my data"}
            </OSButton>
          )}
          {privacy.deleteHistory && (
            <OSButton ref={historyButton} onClick={() => ask("history")} disabled={actionsLocked} aria-expanded={asking === "history"}>
              {COPY.history.open}
            </OSButton>
          )}
          {privacy.deleteAccount && (
            <OSButton ref={accountButton} onClick={() => ask("account")} disabled={actionsLocked} aria-expanded={asking === "account"}>
              {COPY.account.open}
            </OSButton>
          )}
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

export function AccountDeletionComplete({ status, onRetry }: {
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
                <p>your sign-in is deleted too.</p>
                {status === "pending" && <p>signing out…</p>}
                {status === "done" && <p>you&apos;re signed out.</p>}
              </div>
              {status === "failed" && (
                <>
                  <p role="alert">couldn&apos;t sign you out. try signing out again.</p>
                  <div className="larper-data-actions">
                    <OSButton primary onClick={onRetry}>retry sign-out</OSButton>
                    <Link href="/" replace className="larper-os-button">back to larper</Link>
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

/**
 * The data is deleted but Clerk didn't remove the sign-in. They stay signed in; "try again"
 * repeats DELETE /me (the API recreates an empty row for the session, purges it and retries Clerk).
 */
export function SignInRemovalFailed({ onRemoved }: { onRemoved: () => void }) {
  const api = useApi();
  const ref = useRef<HTMLHeadingElement>(null);
  const active = useRef(false);
  const busy = useRef(false);
  const [trying, setTrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => ref.current?.focus(), []);
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  async function retry() {
    if (busy.current) return;
    busy.current = true;
    setTrying(true);
    setError(null);
    try {
      const r = await api<AccountDeleted>("/me", { method: "DELETE" });
      if (!active.current) return;
      if (r.clerkUser === "deleted") onRemoved();
      else setError("your sign-in is still there. try again in a bit.");
    } catch (e) {
      if (!active.current) return;
      if (accountAlreadyGone(e)) onRemoved();
      else setError(failure(e));
    } finally {
      busy.current = false;
      if (active.current) setTrying(false);
    }
  }

  return (
    <main className={`${larperOsClassName} larper-journal`}>
      <OSMenuBar />
      <div className="larper-journal-stage">
        <OSWindow title="your data">
          <OSQuestPanel>
            <div className="larper-data">
              <h1 ref={ref} tabIndex={-1} className="larper-journal-name">your larper data is deleted.</h1>
              <p>removing your sign-in didn&apos;t go through, so you&apos;re still signed in.</p>
              <div className="larper-data-actions">
                <OSButton primary onClick={() => void retry()} disabled={trying} aria-busy={trying}>
                  {trying ? "trying…" : "try again"}
                </OSButton>
              </div>
              <p role="status">{error}</p>
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
  const describeId = useId();
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
      aria-describedby={describeId}
      className="larper-data-confirm"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) onCancel();
      }}
    >
      <h3 id={titleId} className="larper-journal-name">{copy.title}</h3>
      <div id={describeId}>
      <p>this deletes:</p>
      <ul>{copy.deletes.map((d) => <li key={d}>{d}</li>)}</ul>
      {copy.keeps && (
        <>
          <p>this keeps:</p>
          <ul>{copy.keeps.map((d) => <li key={d}>{d}</li>)}</ul>
        </>
      )}
      {kind === "account" && (
        <p>this deletes your larper data and your sign-in, then signs you out. {NEW_ACCOUNT}</p>
      )}
      </div>
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
