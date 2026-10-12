"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApi, type Me } from "@/lib/api";

// Signed-in home state: send new users to onboarding, show returning users what
// their taste vector leans toward.
export function MeStatus() {
  const api = useApi();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Me>("/me").then(setMe, (e: Error) => setError(e.message));
  }, [api]);

  if (error) return <p className="text-red-700">Couldn&apos;t reach the API: {error}</p>;
  if (!me) return <p className="text-neutral-500">Checking your quest log…</p>;

  if (!me.onboarded) {
    return (
      <Link href="/onboarding" className="rounded-md bg-neutral-900 px-4 py-2 text-white">
        Set your vibes
      </Link>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-neutral-500">Leaning toward {me.topTags.join(", ")}.</p>
      <Link href="/onboarding" className="text-sm underline">Redo vibes</Link>
    </div>
  );
}
