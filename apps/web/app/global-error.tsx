"use client";

// The last-resort error page, for an error the root layout itself couldn't render
// past. It replaces the root layout, so it brings its own <html> and <body>. Reports
// the error to Sentry (scrubbed, lib/sentry-scrub.ts).
import * as Sentry from "@sentry/nextjs";
import Link from "next/link";
import { useEffect } from "react";
import { LarperOsPageShell } from "@/components/larper-os/page-shell";
import { OSButton } from "@/components/larper-os/primitives";
import "./globals.css";
import { larperOsClassName } from "./larper-os";

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en" className="h-full antialiased">
      <body className={`${larperOsClassName} flex min-h-full flex-col`}>
        <LarperOsPageShell title="something went wrong.">
          <div className="larper-os-page-actions">
            <OSButton primary onClick={() => retry()}>try again</OSButton>
            <Link href="/" className="larper-os-page-link">back to the map</Link>
          </div>
        </LarperOsPageShell>
      </body>
    </html>
  );
}
