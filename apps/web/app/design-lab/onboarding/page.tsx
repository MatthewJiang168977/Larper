import { assertDesignLab } from "../assert-design-lab";
import { OnboardingFixture } from "./onboarding-fixture";

export default function OnboardingPreviewPage() {
  assertDesignLab();
  return <OnboardingFixture />;
}
