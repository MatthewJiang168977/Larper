"use client";

// The last-resort error page, for an error the root layout itself couldn't render
// past. It replaces the root layout, so it brings its own <html> and <body>. Reports
// the error to Sentry (scrubbed, lib/sentry-scrub.ts).
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import "./globals.css";

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col items-center justify-center gap-6 bg-paper p-6 text-center">
        <h1 className="font-serif text-2xl">Something went wrong.</h1>
        <button type="button" onClick={() => retry()} className="stamp-btn min-h-11 rounded-md bg-oxblood px-4 py-2 text-paper">
          Try again
        </button>
      </body>
    </html>
  );
}
