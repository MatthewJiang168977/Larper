import type { Metadata } from "next";
import Link from "next/link";
import { LarperOsPageShell } from "@/components/larper-os/page-shell";

export const metadata: Metadata = { title: "Terms · Larper" };

// Plain-language terms for a small, free pilot. Not legal advice: the owner approves
// every change to this wording.
const TERMS: { title: string; points: string[] }[] = [
  {
    title: "What Larper is",
    points: [
      "A free app that suggests one place a day near you in New York City, for you to visit if you want to.",
      "It's an early pilot run by one person. Features can change, break or go away, and the service can stop.",
    ],
  },
  {
    title: "Places can be wrong",
    points: [
      "Place details come from open data and from other people's answers. A place may be closed, moved, gone, or not what it sounds like.",
      "Check before you go, especially at night. Larper doesn't vouch for any place it suggests and isn't paid by them.",
    ],
  },
  {
    title: "Getting there is up to you",
    points: [
      "Use your own judgement about where you go, when, and how. Follow the law and the place's own rules.",
      "Don't go somewhere that feels unsafe, and don't look at the app while crossing the street.",
    ],
  },
  {
    title: "Your account",
    points: [
      "Keep your sign-in to yourself. You're responsible for what's done with your account.",
      "Don't fake check-ins, scrape the app, overload it, or try to get at other people's data. Accounts that do can be removed.",
      "The shared demo account is for trying Larper. Other visitors can see what's done there, and it's reset every night.",
    ],
  },
  {
    title: "Your data",
    points: [
      "The privacy page says what Larper keeps, what it shares, and how to download or delete it.",
    ],
  },
  {
    title: "No guarantees",
    points: [
      "Larper is provided as it is, without warranties. As far as the law allows, Larper isn't liable for losses that come from using it or from visiting a place it suggested.",
    ],
  },
  {
    title: "Changes",
    points: [
      "These terms can change. The date at the top shows the last change. Using Larper after a change means you accept the new terms.",
    ],
  },
];

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

const TERMS_UPDATED = "22 November 2026";

export default function TermsPage() {
  return (
    <LarperOsPageShell title="Terms" wide>
      <div className="larper-os-privacy">
        <Link href="/" className="larper-os-page-link justify-self-start">
          ← Larper
        </Link>
        <p className="text-sm">Last changed {TERMS_UPDATED}.</p>
        <p>By using Larper you agree to these terms. They&apos;re short on purpose.</p>

        <div className="larper-os-privacy-groups">
          {TERMS.map((s) => (
            <section key={s.title} aria-labelledby={`terms-${slug(s.title)}`}>
              <h2 id={`terms-${slug(s.title)}`}>{s.title}</h2>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
                {s.points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <p className="text-sm">
          See also <Link href="/privacy" className="underline underline-offset-2">privacy</Link> and{" "}
          <Link href="/credits" className="underline underline-offset-2">credits</Link>.
        </p>
      </div>
    </LarperOsPageShell>
  );
}
