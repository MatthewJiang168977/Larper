import { larperOsClassName } from "../larper-os";
import { assertDesignLab } from "./assert-design-lab";
import { QuestFixture } from "./quest-fixture";

export default function DesignLab() {
  return <main className={larperOsClassName}><QuestFixture /></main>;
}
