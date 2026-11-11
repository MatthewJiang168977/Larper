import { assertDesignLab } from "../assert-design-lab";
import { QuestScreenFixture } from "./quest-screen-fixture";

export default function QuestPreviewPage() {
  assertDesignLab();
  return <QuestScreenFixture />;
}
