import { makeQuestMapStyle } from "./journal-style";

export const larperOsDayStyle = makeQuestMapStyle({
  paper: "#f6d5d5",
  paperDeep: "#f4cbd5",
  park: "#cde6be",
  wood: "#cde6be",
  water: "#a9dde3",
  waterLine: "#74bcc6",
  waterLabel: "#3a2432",
  // Cream roads on pink are about 1.3:1, so each road gets a dusty-rose outline: 3.19:1
  // against the paper (map-contrast.test.ts). The roads themselves keep the Larper OS look.
  casing: "#9e6b77",
  inkMajor: "#fff9f2",
  inkMinor: "#fff9f2",
  inkPath: "#fff9f2",
  building: "#fff6ec",
  buildingTop: "#f6e6d6",
  // The 2D footprints' edge: 2.84:1 on the paper and 3.62:1 against the building fill.
  buildingEdge: "#a8737f",
  label: "#3a2432",
  labelHalo: "#f6d5d5",
}, {
  anchor: "map", color: "#fff4df", intensity: 0.35, position: [1.4, 210, 40],
});

export const larperOsNightStyle = makeQuestMapStyle({
  paper: "#251e29",
  paperDeep: "#312535",
  park: "#25352c",
  wood: "#25352c",
  water: "#182e35",
  waterLine: "#335663",
  waterLabel: "#b9e3e6",
  casing: "#251e29", // the paper: at night the roads carry their own contrast
  // 4.11:1 on the paper and 3.28:1 over parks (was #675263, about 2.1:1).
  inkMajor: "#8f7a8b",
  inkMinor: "#8f7a8b",
  inkPath: "#8f7a8b",
  building: "#51414b",
  buildingTop: "#6a5363",
  buildingEdge: "#3e323d",
  label: "#f9efe4",
  labelHalo: "#251e29",
}, {
  anchor: "map", color: "#b9e3e6", intensity: 0.22, position: [1.4, 230, 55],
});
