import type { Metadata } from "next";
import { CurationPage } from "@/components/curation/curation-page";
import { RequireSignIn } from "@/components/require-sign-in";

// The curator's page. Linked from nowhere; the API answers 404 to anyone who isn't an
// admin (ADMIN_USER_IDS), and then this page shows "not found" too.
export const metadata: Metadata = { title: "Places · Larper", robots: { index: false, follow: false } };

export default function AdminPlaces() {
  return (
    <RequireSignIn>
      <CurationPage />
    </RequireSignIn>
  );
}
