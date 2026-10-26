import type { DeckItem, QuestView } from "@/lib/api";

// The contract every map renderer implements. Today that's MapLibre over
// OpenStreetMap; Google Photorealistic 3D Tiles can implement the same props later
// without touching the quest UI.
export interface QuestMapProps {
  /** Where the user is; `accuracyM` (the fix's radius) sizes the halo around the dot. */
  me: { lat: number; lng: number; accuracyM?: number };
  quest: QuestView | null;
  deck: DeckItem[];
  /** Place id of the pin in focus; the map flies to it. */
  selectedId: string | null;
  onSelect: (placeId: string) => void;
  /** Pixels covered by the bottom sheet, so fly-to centers the pin in the visible part. */
  bottomInset: number;
  /** Pixels covered on the right (the open sheet on a wide screen: pins go left of it). */
  rightInset?: number;
  /**
   * Where the map's buttons (compass, 2D/3D) go: the page's top bar, so they wrap below
   * its other contents when the two don't fit side by side. Without one, top right.
   */
  controlsHost?: HTMLElement | null;
}
