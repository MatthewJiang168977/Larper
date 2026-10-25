import { Show, SignInButton, SignUpButton } from "@clerk/nextjs";
import { Suspense } from "react";
import { demoEnabled } from "@/components/auth/demo-account";
import { TryDemoButton } from "@/components/auth/try-demo";
import { QuestHome } from "@/components/quest/quest-home";

export default function Home() {
  // Show reads the auth cookie, which is request-time data: with cacheComponents it
  // must sit inside Suspense so the static shell can still be prerendered.
  return (
    <Suspense fallback={<main className="flex-1" />}>
      <Show when="signed-out">
        <main className="flex flex-1 flex-col items-center justify-center gap-8 px-4 text-center">
          <div className="space-y-3">
            <p className="field-label">A field journal for side quests</p>
            <h1 className="text-6xl font-semibold tracking-tight [font-variation-settings:'opsz'_144,'SOFT'_50]">
              Larper
            </h1>
            <p className="mx-auto max-w-sm text-lg text-ink-soft">
              One quest a day: the most niche spot near you that fits your taste.
            </p>
            <p className="field-label">New York City, for now</p>
          </div>
          <ul className="space-y-1 border-l-2 border-rule pl-3 text-left font-mono text-sm text-ink-soft">
            <li>Hojicha soft serve in a mall basement.</li>
            <li>A photobooth bar.</li>
            <li>The dumpling counter with no sign.</li>
          </ul>
          <div className="flex items-start gap-3">
            <SignInButton>
              <button className="stamp-btn rounded-md bg-paper px-4 py-2">Sign in</button>
            </SignInButton>
            {/* Sign-ups by invitation only (the public demo): the main button signs in
                as the shared demo account instead. */}
            {demoEnabled(process.env.NEXT_PUBLIC_SIGNUP_MODE) ? (
              <TryDemoButton className="stamp-btn rounded-md bg-oxblood px-4 py-2 text-paper" />
            ) : (
              <SignUpButton>
                <button className="stamp-btn rounded-md bg-oxblood px-4 py-2 text-paper">Start a quest log</button>
              </SignUpButton>
            )}
          </div>
        </main>
      </Show>

      <Show when="signed-in">
        <QuestHome />
      </Show>
    </Suspense>
  );
}
