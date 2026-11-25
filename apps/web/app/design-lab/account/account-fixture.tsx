"use client";

// The account window without a Clerk instance: stand-in tabs where Clerk draws its own, over
// the real "your data" page. Nothing here is pressed against a live API.
import { AccountDataPage } from "@/components/auth/account-data-page";
import { AccountFrame } from "@/components/auth/account-frame";
import { OSButton } from "@/components/larper-os/primitives";
import "@/components/larper-os/journal.css";
import "@/components/larper-os/your-data.css";

export function AccountFixture() {
  return (
    <AccountFrame>
      <div className="larper-data-actions">
        {["profile", "security", "your data", "weekly email"].map((tab) => <OSButton key={tab}>{tab}</OSButton>)}
      </div>
      <AccountDataPage
        privacy={{ export: true, deleteHistory: true, deleteAccount: true }}
        onAccountDeleted={() => {}}
      />
    </AccountFrame>
  );
}
