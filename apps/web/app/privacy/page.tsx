import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy · Larper" };

// What the three measuring services see. Keep in step with lib/analytics.ts (PostHog),
// components/web-analytics.tsx (Vercel) and lib/sentry-options.ts + sentry-scrub.ts.
const SERVICES: { name: string; what: string; collects: string[] }[] = [
  {
    name: "Vercel Web Analytics",
    what: "Counts page visits.",
    collects: [
      "The page's address, without anything after a ? or #, and the site you came from.",
      "Your browser, operating system, device type and country.",
      "No cookies. Visitors are told apart by a hash that changes every day.",
    ],
  },
  {
    name: "PostHog",
    what: "Counts a few steps in the app, so we can see where people get stuck.",
    collects: [
      "Viewing the home page, trying the demo, finishing setup, and opening the journal.",
      "Being offered, accepting, skipping or setting aside a quest, plus the optional reason for setting it aside.",
      "Checking in, whether it went through, and whether it was a demo check-in.",
      "Your answer (yes, no or didn't check) when Larper asks whether a place was open. Larper itself keeps that answer with the place, to show how many people confirmed it open; PostHog only gets the answer.",
      "For quests: only the kind of place (say, “bakery”) and roughly how far it was (like “1–2 km”).",
      "Whether you're on the shared demo account, plus your browser, operating system, screen size and the page.",
      "No cookies or storage on your device, no account or email, and no recordings of the screen. Your IP address isn't kept and isn't used to locate you.",
    ],
  },
  {
    name: "Sentry",
    what: "Reports errors and how long things take, so we can fix what breaks.",
    collects: [
      "The error and where in the code it happened, your browser and operating system, and the page.",
      "Timings for about 1 in 10 page loads and requests.",
      "Emails, sign-in tokens, cookies, coordinates and place IDs are removed before anything is sent. No recordings of the screen.",
    ],
  },
];

// Keep in step with apps/api/src/privacy and docs/decisions/0005-data-deletion.md.
const YOUR_DATA: { title: string; points: string[] }[] = [
  {
    title: "Download my data",
    points: [
      "One JSON file with your Larper account record (its ID, Clerk ID and creation date), taste profile, quest journal with places, check-ins and check-in attempts, answers to “was it open?”, and saved places.",
      "For open or accepted quests, the journal includes your precise location at the time of the offer if Larper still holds it. Check-in attempts include measurements such as distance and location accuracy.",
      "Find it under “your data” at the bottom of the journal.",
    ],
  },
  {
    title: "Delete my history",
    points: [
      "Removes your journal, check-ins and attempts, “was it open?” answers and saved places.",
      "Keeps your account, your sign-in and your taste profile.",
    ],
  },
  {
    title: "Delete my account",
    points: [
      "Removes all of the above, plus your taste profile and your Larper account.",
      "Also deletes your sign-in, then signs you out. If removing the sign-in doesn't go through, your data is still deleted and you stay signed in to try again.",
      "You can sign up again later, with the same email if you like. That makes a new, empty account. After deletion Larper writes nothing new that identifies you. Records made before, such as server logs and event records, keep your account number until they expire on their usual schedule.",
    ],
  },
  {
    title: "Backups",
    points: [
      "Copies of deleted data can stay for about 3 weeks under the usual backup schedule. Backup storage has a 60-day cleanup rule for old objects.",
      "Restoring a backup could bring back data deleted after that backup was taken. You can delete it again if that happens.",
      "The shared demo account can't be exported or deleted because it belongs to every visitor.",
    ],
  },
  {
    title: "Events already sent",
    points: [
      "Events already sent to our event broker can remain after deletion until its scheduled cleanup, with no fixed deletion deadline.",
    ],
  },
];

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-4 py-8">
      <Link href="/" className="hit-target font-mono text-xs uppercase tracking-wider text-ink-soft underline-offset-4 hover:underline">
        ← Larper
      </Link>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight">Privacy</h1>
      <p className="mt-3 text-ink-soft">
        Larper uses your location to find quests near you. That stays with Larper: none of the services below get your
        coordinates, addresses, or the names of the places you&apos;re sent to.
      </p>
      <p className="mt-3 text-ink-soft">Three services help us see whether Larper works:</p>

      <div className="mt-6 divide-y divide-rule border-y border-rule">
        {SERVICES.map((s) => (
          // An id without spaces: aria-labelledby reads a space as a list of ids.
          <section key={s.name} aria-labelledby={`svc-${slug(s.name)}`} className="py-5">
            <h2 id={`svc-${slug(s.name)}`} className="text-xl font-medium">
              {s.name}
            </h2>
            <p className="mt-1 text-ink-soft">{s.what}</p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
              {s.collects.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <h2 className="mt-8 text-2xl font-medium">Your data</h2>
      <p className="mt-2 text-ink-soft">You can take your data with you, or delete it, from the journal. Some options are switched on step by step, and the journal shows only the ones that are available.</p>
      <div className="mt-4 divide-y divide-rule border-y border-rule">
        {YOUR_DATA.map((s) => (
          <section key={s.title} aria-labelledby={`data-${slug(s.title)}`} className="py-5">
            <h3 id={`data-${slug(s.title)}`} className="text-lg font-medium">
              {s.title}
            </h3>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
              {s.points.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <p className="mt-6 text-sm text-ink-soft">
        Signing in uses Clerk, which sets the cookies that keep you signed in. Nothing here is sold or used for ads.
      </p>
    </main>
  );
}
