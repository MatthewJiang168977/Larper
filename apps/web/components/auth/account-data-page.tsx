// "your data" inside the account window: what is kept, then the same download and delete
// controls and endpoints as before (YourData). Only what GET /me reports as on is shown.
import Link from "next/link";
import { DATA_KEPT } from "@/components/larper-os/data-copy";
import { YourData, type ClerkRemoval } from "@/components/larper-os/your-data";
import type { Privacy } from "@/lib/api";

export function AccountDataPage({ privacy, onAccountDeleted }: {
  privacy: Privacy;
  onAccountDeleted: (clerkUser: ClerkRemoval) => void;
}) {
  return (
    <YourData
      account="user"
      privacy={privacy}
      onAccountDeleted={onAccountDeleted}
      onAccountDeletePendingChange={() => {}}
      onHistoryDeleted={() => {}}
      lead={
        <>
          <p>what larper keeps about you, in plain words.</p>
          <dl className="larper-account-kept">
            {DATA_KEPT.map(({ name, what }) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
          <p className="larper-account-fine">
            never sold or used for ads. backup copies of deleted data expire on the usual schedule;{" "}
            <Link href="/privacy" className="larper-account-link">privacy</Link> has the details.
          </p>
        </>
      }
    />
  );
}
