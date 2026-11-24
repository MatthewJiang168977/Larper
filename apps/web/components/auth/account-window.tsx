"use client";

// The account window: Clerk's profile, framed by the OS window the page puts around it,
// plus our own "your data" page. The shared demo account has no profile of its own, so it
// gets a note instead of Clerk's forms (it must not be able to change its sign-in).
import { UserProfile, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useState } from "react";
import { userProfileAppearance } from "@/components/auth/clerk-appearance";
import { AccountDataPage } from "@/components/auth/account-data-page";
import { osPrimaryButtonClass } from "@/components/larper-os/primitives";
import { useApi, type Me } from "@/lib/api";
import "./larper-os-account-window.css";

const dataIcon = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M12 4c4.4 0 8 1.1 8 2.5S16.4 9 12 9 4 7.9 4 6.5 7.6 4 12 4zM4 6.5v11C4 18.9 7.6 20 12 20s8-1.1 8-2.5v-11" />
  </svg>
);

export function AccountWindow() {
  const api = useApi();
  const { user } = useUser();
  const [demo, setDemo] = useState<boolean | null>(null);

  useEffect(() => {
    let current = true;
    api<Me>("/me").then(
      (m) => { if (current) setDemo(m?.demo === true); },
      // If /me fails, Clerk's own forms still need their own re-verification to change anything.
      () => { if (current) setDemo(false); },
    );
    return () => { current = false; };
  }, [api]);

  if (demo === null) return <p className="larper-os-account-note" role="status">loading your account…</p>;
  if (demo) {
    return (
      <div className="larper-os-account-note">
        <p>the shared demo account has no settings of its own.</p>
        <Link href="/" className={osPrimaryButtonClass}>back to larper</Link>
      </div>
    );
  }
  return (
    <UserProfile routing="path" path="/account" appearance={userProfileAppearance(user)}>
      <UserProfile.Page label="your data" url="your-data" labelIcon={dataIcon}>
        <AccountDataPage />
      </UserProfile.Page>
    </UserProfile>
  );
}
