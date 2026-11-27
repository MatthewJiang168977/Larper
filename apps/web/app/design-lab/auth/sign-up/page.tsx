import { Suspense } from "react";
import { LarperOsAuthShell } from "@/components/auth/larper-os-auth-shell";
import { assertDesignLab } from "../../assert-design-lab";
import { LabAuth, type LabSearchParams } from "../lab-shell";
import { ClerkStandIn } from "../stand-in";

export default function SignUpFixture({ searchParams }: { searchParams: LabSearchParams }) {
  assertDesignLab();
  return (
    <Suspense fallback={null}>
      <LabAuth searchParams={searchParams}>
        <LarperOsAuthShell page="sign up">
          <ClerkStandIn heading="create your account" sub="welcome in." />
        </LarperOsAuthShell>
      </LabAuth>
    </Suspense>
  );
}
