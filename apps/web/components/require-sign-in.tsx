"use client";

import { RedirectToSignIn, Show } from "@clerk/nextjs";

// Per-page auth check (Clerk's recommendation over path matching in middleware).
// This only spares signed-out visitors a page of 401s; the API's JWT guard is
// what actually protects the data.
export function RequireSignIn({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Show when="signed-out">
        <RedirectToSignIn />
      </Show>
      <Show when="signed-in">{children}</Show>
    </>
  );
}
