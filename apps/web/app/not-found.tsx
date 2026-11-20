import Link from "next/link";
import { LarperOsPageShell } from "@/components/larper-os/page-shell";

export default function NotFound() {
  return (
    <LarperOsPageShell title="page not found">
      <Link href="/" className="larper-os-page-link justify-self-start">back to the map</Link>
    </LarperOsPageShell>
  );
}
