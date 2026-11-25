import { LarperOsAuthShell } from "@/components/auth/larper-os-auth-shell";
import { assertDesignLab } from "../../assert-design-lab";
import { ClerkStandIn } from "../stand-in";

export default function SignUpFixture() {
  assertDesignLab();
  return (
    <LarperOsAuthShell page="sign up">
      <ClerkStandIn heading="welcome in." sub="one quest a day, picked for you." />
    </LarperOsAuthShell>
  );
}
