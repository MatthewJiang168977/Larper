import { LarperOsAuthShell } from "@/components/auth/larper-os-auth-shell";
import { DemoPanel, DemoWindow } from "@/components/auth/try-demo";
import { assertDesignLab } from "../assert-design-lab";
import { ClerkStandIn } from "./stand-in";

export default function SignInFixture() {
  assertDesignLab();
  return (
    <LarperOsAuthShell page="sign in" demo={<DemoPanel signUpMode="restricted" />} demoWindow={<DemoWindow />}>
      <ClerkStandIn heading="sign in to larper" />
    </LarperOsAuthShell>
  );
}
