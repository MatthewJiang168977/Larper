import { assertDesignLab } from "../assert-design-lab";
import { JournalFixture } from "./journal-fixture";

export default function JournalPreviewPage() {
  assertDesignLab();
  return <JournalFixture />;
}
