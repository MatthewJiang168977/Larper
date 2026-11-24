"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useState } from "react";
import { OSButton } from "@/components/larper-os/primitives";
import { describeError, useApi } from "@/lib/api";

type Preference = { enabled: boolean };
const path = "/me/weekly-email";

export function WeeklyEmailPreference() {
  const { sessionId } = useAuth();
  return sessionId ? <PreferenceForm key={sessionId} /> : <p role="status">Loading your preference…</p>;
}

function PreferenceForm() {
  const api = useApi();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    api<Preference>(path, { signal: controller.signal }).then(
      (reply) => { if (!controller.signal.aborted) setEnabled(reply.enabled); },
      (reason: unknown) => {
        if (!controller.signal.aborted) setError(describeError(reason, "Could not load your email preference."));
      },
    );
    return () => controller.abort();
  }, [api, attempt]);

  async function change() {
    setPending(true);
    setError(null);
    try {
      const reply = await api<Preference>(path, { method: "PUT", body: JSON.stringify({ enabled: !enabled }) });
      setEnabled(reply.enabled);
    } catch (reason) {
      setError(describeError(reason, "Could not save your email preference."));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <p>Get one quest teaser and your saved-place count on Thursday evenings at your verified primary email address.</p>
      <p>Resend delivers the email. Larper does not track opens or clicks.</p>
      <p role="status">
        {enabled === null ? error ? "" : "Loading your preference…" : enabled ? "You’re subscribed." : "You’re unsubscribed."}
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="larper-os-page-actions">
        {enabled !== null && (
          <OSButton primary={!enabled} disabled={pending} onClick={() => void change()}>
            {pending ? "saving…" : enabled ? "unsubscribe" : "subscribe"}
          </OSButton>
        )}
        {enabled === null && error && (
          <OSButton onClick={() => { setError(null); setAttempt((n) => n + 1); }}>try again</OSButton>
        )}
        <Link href="/" className="larper-os-page-link">back to the map</Link>
      </div>
    </>
  );
}
