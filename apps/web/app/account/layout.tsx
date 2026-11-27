import { ClerkLoading } from "@clerk/nextjs";
import { Suspense, type ReactNode } from "react";
import { AccountFrame } from "@/components/auth/account-frame";
import { AccountWindow } from "@/components/auth/account-window";
import "@/components/larper-os/journal.css";
import "@/components/larper-os/your-data.css";
import "@/components/larper-os/page-shell.css";

// The window lives in the layout, so it stays put while the tabs change the route. Clerk's
// profile reads the URL at request time, which can't be part of the prerendered shell under
// Cache Components: the frame prerenders, the profile streams in.
export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <AccountFrame>
      <ClerkLoading>
        <p role="status">loading your account…</p>
      </ClerkLoading>
      <Suspense fallback={null}>
        <AccountWindow />
        {children}
      </Suspense>
    </AccountFrame>
  );
}
