import type { LightSpecification } from "maplibre-gl";
import { makeQuestMapStyle } from "./journal-style";

// Each phase's exact palette. Colours blend between neighbouring phases (map-blend.ts); the
// light's position is set from the sun at runtime, so the one here is only a starting value.
// Contrast is checked in map-contrast.test.ts.
const light = (color: string, intensity: number): LightSpecification =>
  ({ anchor: "map", color, intensity, position: [1.4, 210, 40] });

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
  // The 2D footprints' edge: 3.19:1 on the paper (was #a8737f, 2.84:1).
  buildingEdge: "#9e6b77",
  buildingOpacity: 0.72,
  label: "#3a2432",
  labelHalo: "#f6d5d5",
}, light("#fff4df", 0.35));

export const larperOsDawnStyle = makeQuestMapStyle({
  paper: "#EADFEE",
  paperDeep: "#DFD2E5",
  park: "#CFE2C9",
  wood: "#CFE2C9",
  water: "#BFD8EE",
  waterLine: "#7FA3C7",
  waterLabel: "#2E2A48",
  casing: "#85779A", // 3.19:1 on the land: the streets are nearly white
  inkMajor: "#FBF4F4",
  inkMinor: "#FBF4F4",
  inkPath: "#FBF4F4",
  building: "#FDEBE1",
  buildingTop: "#F4CBD2",
  buildingEdge: "#85697F",
  buildingOpacity: 0.72,
  label: "#2E2A48",
  labelHalo: "#EADFEE",
}, light("#FFD8BF", 0.3));

export const larperOsGoldenStyle = makeQuestMapStyle({
  paper: "#F7D8A6",
  paperDeep: "#EFCB93",
  park: "#CBD68F",
  wood: "#CBD68F",
  water: "#93CBC9",
  waterLine: "#5FA3A3",
  waterLabel: "#3E2610",
  casing: "#946A38",
  inkMajor: "#FFF2D2",
  inkMinor: "#FFF2D2",
  inkPath: "#FFF2D2",
  building: "#FFE8BE",
  buildingTop: "#F3B378",
  buildingEdge: "#8F5F32",
  buildingOpacity: 0.72,
  label: "#3E2610",
  labelHalo: "#F7D8A6",
}, light("#FFC56B", 0.38));

export const larperOsDuskStyle = makeQuestMapStyle({
  paper: "#F2A58F",
  paperDeep: "#E89580",
  park: "#CFA88F",
  wood: "#CFA88F",
  water: "#8E9BDC",
  waterLine: "#6676C0",
  waterLabel: "#2A1236",
  casing: "#7E4452",
  inkMajor: "#FFDCC9",
  inkMinor: "#FFDCC9",
  inkPath: "#FFDCC9",
  building: "#F8BBC8", // pink at ground level, lilac by 120 m
  buildingTop: "#BBA3E8",
  buildingEdge: "#74404E",
  buildingOpacity: 0.72,
  label: "#2A1236",
  labelHalo: "#F2A58F",
}, light("#FF9E7A", 0.32));

export const larperOsNightStyle = makeQuestMapStyle({
  paper: "#251e29",
  paperDeep: "#312535",
  park: "#25352c",
  wood: "#25352c",
  // The darkest surface, so the land reads as lit and the water as a void. The thin
  // coastline (the water's outline and the waterways) is lighter than the water.
  water: "#070B1F",
  waterLine: "#3f6b7a",
  waterLabel: "#b9e3e6",
  casing: "#251e29", // the paper: at night the roads carry their own contrast
  // 4.11:1 on the paper and 3.28:1 over parks (was #675263, about 2.1:1).
  inkMajor: "#8f7a8b",
  inkMinor: "#8f7a8b",
  inkPath: "#8f7a8b",
  building: "#51414b",
  buildingTop: "#6a5363",
  buildingEdge: "#8f7a8b", // 4.11:1 on the paper (was #3e323d, 1.3:1)
  buildingOpacity: 1,
  label: "#f9efe4",
  labelHalo: "#251e29",
}, light("#b9e3e6", 0.22));

export const larperOsPhaseStyles = {
  dawn: larperOsDawnStyle,
  day: larperOsDayStyle,
  golden: larperOsGoldenStyle,
  dusk: larperOsDuskStyle,
  night: larperOsNightStyle,
} as const;
