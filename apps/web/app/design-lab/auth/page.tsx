import { Suspense } from "react";
import { LarperOsAuthShell } from "@/components/auth/larper-os-auth-shell";
import { DemoPanel } from "@/components/auth/try-demo";
import { assertDesignLab } from "../assert-design-lab";
import { LabAuth, type LabSearchParams } from "./lab-shell";
import { ClerkStandIn } from "./stand-in";

// Reading searchParams is runtime data, so it sits inside Suspense.
export default function SignInFixture({ searchParams }: { searchParams: LabSearchParams }) {
  assertDesignLab();
  return (
    <Suspense fallback={null}>
      <LabAuth searchParams={searchParams}>
        <LarperOsAuthShell page="sign in" demo={<DemoPanel signUpMode="restricted" />}>
          <ClerkStandIn heading="sign in to larper" />
        </LarperOsAuthShell>
      </LabAuth>
    </Suspense>
  );
}
