import Link from "next/link";
import { LarperLanding } from "@/components/larper-os/landing";
import { osPrimaryButtonClass } from "@/components/larper-os/primitives";
import { assertDesignLab } from "../assert-design-lab";

export default function LandingFixture() {
  assertDesignLab();
  return (
    <LarperLanding preview actions={
      <>
        <Link href="/design-lab" className={osPrimaryButtonClass}>try the quest fixture</Link>
        <p>sign-in is available on the app’s landing page.</p>
      </>
    } />
  );
}
