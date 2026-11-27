import { assertDesignLab } from "../assert-design-lab";
import { AccountFixture } from "./account-fixture";

export default function AccountFixturePage() {
  assertDesignLab();
  return <AccountFixture />;
}
