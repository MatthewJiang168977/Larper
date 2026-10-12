import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import { MeStatus } from "./me-status";

// Placeholder landing until the 3D map lands (milestone 5). Plain on purpose:
// the field-journal styling comes with the real UI.
export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-4 text-center">
      <div className="space-y-2">
        <h1 className="text-4xl font-semibold tracking-tight">Larper</h1>
        <p className="text-neutral-500">The most niche thing to do near you.</p>
      </div>

      <Show when="signed-out">
        <div className="flex gap-3">
          <SignInButton>
            <button className="rounded-md border border-neutral-300 px-4 py-2">Sign in</button>
          </SignInButton>
          <SignUpButton>
            <button className="rounded-md bg-neutral-900 px-4 py-2 text-white">Start a quest log</button>
          </SignUpButton>
        </div>
      </Show>

      <Show when="signed-in">
        <div className="flex flex-col items-center gap-4">
          <UserButton />
          <MeStatus />
        </div>
      </Show>
    </main>
  );
}
