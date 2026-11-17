"use client";

import { useClerk } from "@clerk/nextjs";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApiError, describeError, useApi } from "@/lib/api";
import { OSButton, OSQuestPanel } from "./primitives";
import "./your-data.css";

/** "checking": /me hasn't answered. "unknown": it failed, so we can't tell if this is the demo. */
export type AccountKind = "checking" | "user" | "demo" | "unknown";

// Placeholder: the owner removes Clerk sign-ins by hand when the API can't (ADR 0005).
export const MANUAL_REMOVAL_WINDOW = "within 7 days";

const CONFIRM_WORD = "delete";

interface HistoryDeleted {
  deleted: { quests: number; checkInAttempts: number; hoursAnswers: number; savedPlaces: number; events: number };
}
interface AccountDeleted {
  deleted: HistoryDeleted["deleted"] & { tasteProfile: number; account: number };
  clerkUser: "manual" | "deleted" | "failed";
}

type Kind = "history" | "account";

const COPY: Record<Kind, { open: string; title: string; deletes: string[]; keeps: string[]; confirm: string }> = {
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
      "your larper account. you'll be signed out.",
      `your sign-in with clerk, our sign-in service. if it isn't removed straight away, we remove it by hand ${MANUAL_REMOVAL_WINDOW}.`,
    ],
    keeps: ["nothing in the app. you can sign up again later as a new person."],
    confirm: "delete my account",
  },
};

const BACKUPS =
  "deleting can't be undone from the app. copies can stay in our backups for about 3 weeks (60 days at the very most), and restoring a backup could bring deleted data back.";

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

export function YourData({ account, onHistoryDeleted }: { account: AccountKind; onHistoryDeleted: () => void }) {
  const api = useApi();
  const { signOut } = useClerk();
  const headingId = useId();
  const [downloading, setDownloading] = useState(false);
  const [downloadMsg, setDownloadMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [asking, setAsking] = useState<Kind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const lastAsked = useRef<Kind | null>(null);

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
    setNotice(null);
    setDownloadMsg(null);
    lastAsked.current = kind;
    setAsking(kind);
  }

  async function runDelete(kind: Kind) {
    if (kind === "history") {
      const r = await api<HistoryDeleted>("/me/history", { method: "DELETE" });
      onHistoryDeleted();
      setNotice(countLine(r.deleted));
      return;
    }
    const r = await api<AccountDeleted>("/me", { method: "DELETE" });
    // Without a sign-out, the next API call would quietly make a new empty account.
    if (r.clerkUser === "deleted") {
      await signOut({ redirectUrl: "/" });
      return;
    }
    // The sign-in is still waiting for a hand removal: say so before leaving.
    lastAsked.current = null;
    setGone(
      r.clerkUser === "manual"
        ? `your larper data is deleted. your sign-in will be removed by hand ${MANUAL_REMOVAL_WINDOW}.`
        : `your larper data is deleted, but removing your sign-in didn't go through. we'll remove it by hand ${MANUAL_REMOVAL_WINDOW}.`,
    );
  }

  let body: ReactNode;
  if (gone) {
    body = <GonePanel text={gone} onLeave={() => signOut({ redirectUrl: "/" })} />;
  } else if (account === "checking") {
    body = <p role="status">checking your account…</p>;
  } else if (account === "unknown") {
    body = <p>couldn&apos;t check your account. reload the page to see your data options.</p>;
  } else if (account === "demo") {
    body = <p>the shared demo account has no data of its own to download or delete.</p>;
  } else {
    body = (
      <>
        <p>take a copy of what larper holds about you, or wipe it.</p>
        <div className="larper-data-actions">
          <OSButton onClick={download} disabled={downloading} aria-busy={downloading}>
            {downloading ? "preparing…" : "download my data"}
          </OSButton>
          <OSButton ref={historyButton} onClick={() => ask("history")} aria-expanded={asking === "history"}>
            {COPY.history.open}
          </OSButton>
          <OSButton ref={accountButton} onClick={() => ask("account")} aria-expanded={asking === "account"}>
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
            onCancel={() => setAsking(null)}
            run={async () => {
              await runDelete(asking);
              setAsking(null);
            }}
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

function GonePanel({ text, onLeave }: { text: string; onLeave: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div ref={ref} tabIndex={-1} role="status" className="larper-data-confirm">
      <p>{text}</p>
      <p>you&apos;re still signed in here until you leave.</p>
      <OSButton
        primary
        disabled={busy}
        onClick={() => {
          setBusy(true);
          onLeave();
        }}
      >
        {busy ? "signing out…" : "sign out and leave"}
      </OSButton>
    </div>
  );
}

function Confirm({ kind, onCancel, run }: { kind: Kind; onCancel: () => void; run: () => Promise<void> }) {
  const copy = COPY[kind];
  const titleId = useId();
  const inputId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = typed.trim().toLowerCase() === CONFIRM_WORD;

  // Focus moves into the confirmation when it opens.
  useEffect(() => ref.current?.focus(), []);

  async function go() {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(failure(e));
      setBusy(false);
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
      <p>this keeps:</p>
      <ul>{copy.keeps.map((d) => <li key={d}>{d}</li>)}</ul>
      <p>{BACKUPS}</p>
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
