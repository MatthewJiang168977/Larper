// What Larper keeps, in plain words: the account window's "your data" page, and /privacy for the
// location line. Keep in step with docs/decisions/0005-data-deletion.md.
export const LOCATION_KEPT =
  "where you were when a quest was offered, kept only while that quest is open or accepted, then cleared. " +
  "check-in attempts keep the distance and how accurate your location was.";

export const DATA_KEPT: readonly { name: string; what: string }[] = [
  { name: "vibes", what: "your answers from setup, and the taste profile larper learns from them." },
  { name: "journal", what: "every quest you've been handed, and whether you accepted, skipped or checked in." },
  { name: "saves", what: "places you marked want to go, and your \u201cwas it open?\u201d answers." },
  { name: "location", what: LOCATION_KEPT },
];
