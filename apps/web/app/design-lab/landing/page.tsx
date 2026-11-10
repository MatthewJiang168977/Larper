import Link from "next/link";
import { LarperLanding } from "@/components/larper-os/landing";
import { osPrimaryButtonClass } from "@/components/larper-os/primitives";

export default function LandingFixture() {
  return (
    <LarperLanding preview actions={
      <>
        <Link href="/design-lab" className={osPrimaryButtonClass}>try the quest fixture</Link>
        <p>sign-in is available on the app’s landing page.</p>
      </>
    } />
  );
}
