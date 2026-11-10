import type { DeckItem, PlaceView, QuestView } from "@/lib/api";

export const center = { lat: 40.7295, lng: -73.9965 };
const reasons = { liked: [], rarest: null, indie: true };

function samplePlace(id: string, name: string, lat: number, lng: number): PlaceView {
  return { id, name, lat, lng, category: "sample", tags: [], distanceM: 0, website: null, instagram: null, phone: null };
}

export const quest: QuestView = {
  id: "sample-quest",
  status: "offered",
  score: 0,
  reasons,
  createdAt: "2026-01-01T00:00:00Z",
  place: samplePlace("quest", "The Basement Record Shop", 40.7309, -73.9964),
};

export const fixtureLeads = [
  { place: samplePlace("records", "The listening room", 40.7313, -73.9989), note: "a small room with a wall of records." },
  { place: samplePlace("tea", "The tea counter", 40.7303, -73.9948), note: "a hojicha soft serve counter below street level." },
  { place: samplePlace("photos", "The photo booth", 40.7322, -73.9973), note: "a vintage booth tucked behind the bar." },
];

export const deck: DeckItem[] = fixtureLeads.map(({ place }) => ({ place, score: 0, reasons }));
