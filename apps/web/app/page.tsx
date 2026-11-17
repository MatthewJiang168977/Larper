import { Show, SignInButton, SignUpButton } from "@clerk/nextjs";
import { Suspense } from "react";
import { demoEnabled } from "@/components/auth/demo-account";
import { TryDemoButton } from "@/components/auth/try-demo";
import { LarperLanding } from "@/components/larper-os/landing";
import { OSButton, osPrimaryButtonClass } from "@/components/larper-os/primitives";
import { QuestHome } from "@/components/quest/quest-home";
import { TrackLanding } from "@/components/track-landing";

export default function Home() {
  // Show reads the auth cookie, which is request-time data: with cacheComponents it
  // must sit inside Suspense so the static shell can still be prerendered.
  return (
    <Suspense fallback={<main className="flex-1" />}>
      <Show when="signed-out">
        <LarperLanding actions={
          <>
            <TrackLanding />
            {demoEnabled(process.env.NEXT_PUBLIC_SIGNUP_MODE) ? (
              <TryDemoButton className={`${osPrimaryButtonClass} larper-landing-demo-button`} />
            ) : (
              <SignUpButton>
                <OSButton primary>start a quest log</OSButton>
              </SignUpButton>
            )}
            <SignInButton>
              <OSButton>sign in</OSButton>
            </SignInButton>
          </>
        } />
      </Show>

      <Show when="signed-in">
        <QuestHome />
      </Show>
    </Suspense>
  );
}
