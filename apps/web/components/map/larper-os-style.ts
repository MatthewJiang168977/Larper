import { makeQuestMapStyle } from "./journal-style";

export const larperOsDayStyle = makeQuestMapStyle({
  paper: "#f6d5d5",
  paperDeep: "#f4cbd5",
  park: "#cde6be",
  wood: "#cde6be",
  water: "#a9dde3",
  waterLine: "#74bcc6",
  waterLabel: "#3a2432",
  inkMajor: "#fff9f2",
  inkMinor: "#fff9f2",
  inkPath: "#fff9f2",
  building: "#fff6ec",
  buildingTop: "#f6e6d6",
  buildingEdge: "#f0d9ca",
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
  inkMajor: "#675263",
  inkMinor: "#675263",
  inkPath: "#675263",
  building: "#51414b",
  buildingTop: "#6a5363",
  buildingEdge: "#3e323d",
  label: "#f9efe4",
  labelHalo: "#251e29",
}, {
  anchor: "map", color: "#b9e3e6", intensity: 0.22, position: [1.4, 230, 55],
});
