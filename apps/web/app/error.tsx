"use client";

import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";
import { LarperOsPageShell } from "@/components/larper-os/page-shell";
import { OSButton } from "@/components/larper-os/primitives";

export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <LarperOsPageShell title="something went wrong.">
      <div className="larper-os-page-actions">
        <OSButton primary onClick={() => retry()}>try again</OSButton>
        <Link href="/" className="larper-os-page-link">back to the map</Link>
      </div>
    </LarperOsPageShell>
  );
}
