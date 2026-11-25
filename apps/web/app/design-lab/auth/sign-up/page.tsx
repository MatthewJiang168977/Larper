import { LarperOsAuthShell } from "@/components/auth/larper-os-auth-shell";
import { assertDesignLab } from "../../assert-design-lab";
import { ClerkStandIn } from "../stand-in";

export default function SignUpFixture() {
  assertDesignLab();
  return (
    <LarperOsAuthShell page="sign up">
      <ClerkStandIn heading="create your account" sub="welcome in." />
    </LarperOsAuthShell>
  );
}
