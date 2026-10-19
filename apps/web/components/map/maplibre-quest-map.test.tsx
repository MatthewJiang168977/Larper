import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckItem, QuestView } from "@/lib/api";
import { haloDiameterPx } from "./accuracy-halo";
import MapLibreQuestMap, { VIEW_CAMERA } from "./maplibre-quest-map";
import type { QuestMapProps } from "./quest-map";

// --- a stand-in for maplibre-gl: no WebGL, just the calls the component makes ---------

const fake = vi.hoisted(() => {
  const toggle = () => ({ enable: vi.fn(), disable: vi.fn() });
  const rotation = () => ({ enableRotation: vi.fn(), disableRotation: vi.fn() });

  class FakeMap {
    zoom = 15.6;
    listeners = new Map<string, Set<() => void>>();
    container: HTMLElement;
    dragRotate = toggle();
    touchPitch = toggle();
    touchZoomRotate = rotation();
    keyboard = rotation();
    addControl = vi.fn();
    easeTo = vi.fn();
    flyTo = vi.fn();
    remove = vi.fn();
    cameraForBounds = vi.fn(() => ({ center: [-73.99, 40.73], zoom: 16 }));
    constructor(opts: { container: HTMLElement }) {
      this.container = opts.container;
      state.maps.push(this);
    }
    getZoom() {
      return this.zoom;
    }
    getContainer() {
      return this.container;
    }
    on(event: string, fn: () => void) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(fn);
    }
    off(event: string, fn: () => void) {
      this.listeners.get(event)?.delete(fn);
    }
    fire(event: string) {
      this.listeners.get(event)?.forEach((fn) => fn());
    }
  }

  class FakeMarker {
    el: HTMLElement;
    constructor(public opts: { element: HTMLElement; pitchAlignment?: string; rotationAlignment?: string }) {
      this.el = opts.element;
      state.markers.push(this);
    }
    setLngLat() {
      return this;
    }
    addTo(map: FakeMap) {
      map.container.appendChild(this.el);
      return this;
    }
    remove() {
      this.el.remove();
    }
    getElement() {
      return this.el;
    }
  }

  class LngLatBounds {
    extend() {
      return this;
    }
  }

  const state = { maps: [] as FakeMap[], markers: [] as FakeMarker[], FakeMap, FakeMarker, LngLatBounds };
  return state;
});

vi.mock("maplibre-gl", () => ({
  Map: fake.FakeMap,
  Marker: fake.FakeMarker,
  LngLatBounds: fake.LngLatBounds,
  NavigationControl: vi.fn(),
  setWorkerUrl: vi.fn(),
}));

// --- fixtures -------------------------------------------------------------------

const reasons = { liked: [], rarest: null, indie: false };
const place = (id: string, name: string) => ({
  id,
  name,
  lat: 40.731,
  lng: -73.997,
  category: "cafe",
  tags: [],
  distanceM: 100,
  website: null,
  instagram: null,
  phone: null,
});
const quest: QuestView = { id: "q1", status: "offered", score: 1, reasons, createdAt: "", place: place("p1", "Cafe Uno") };
const deck: DeckItem[] = [{ score: 0.5, reasons, place: place("p2", "Bar Dos") }];
const props = (over: Partial<QuestMapProps> = {}): QuestMapProps => ({
  me: { lat: 40.7295, lng: -73.9965, accuracyM: 40 },
  quest,
  deck,
  selectedId: "p1",
  onSelect: vi.fn(),
  bottomInset: 280,
  ...over,
});

const map = () => fake.maps.at(-1)!;
const toggleButton = () => screen.findByRole("button", { name: /^Switch to/ });

beforeEach(() => {
  fake.maps.length = 0;
  fake.markers.length = 0;
});

describe("map markers", () => {
  it("marks the quest with a flag icon (no '!'), labelled with the place's name", async () => {
    render(<MapLibreQuestMap {...props()} />);
    const pin = await screen.findByRole("button", { name: "Cafe Uno" });
    expect(pin.querySelector('svg[data-icon="flag"]')).toBeTruthy();
    expect(pin.querySelectorAll("svg path")).toHaveLength(2); // pole + pennant
    expect(pin.textContent).toBe("");
  });

  it("gives every pin a 44 px hit area", async () => {
    render(<MapLibreQuestMap {...props()} />);
    expect((await screen.findByRole("button", { name: "Cafe Uno" })).classList).toContain("hit-target");
    expect(screen.getByRole("button", { name: "Bar Dos" }).classList).toContain("hit-target");
  });

  it("sizes the halo from the reading's accuracy, flat on the map, and re-measures on zoom", async () => {
    render(<MapLibreQuestMap {...props()} />);
    await toggleButton();
    const halo = document.querySelector<HTMLElement>('[data-testid="me-halo"]')!;
    expect(halo.hidden).toBe(false);
    expect(halo.style.width).toBe(`${haloDiameterPx(40, 40.7295, 15.6)}px`);
    expect(halo.style.height).toBe(halo.style.width);
    expect(fake.markers.find((m) => m.el === halo)?.opts).toMatchObject({ pitchAlignment: "map", rotationAlignment: "map" });

    act(() => {
      map().zoom = 17;
      map().fire("zoom");
    });
    expect(halo.style.width).toBe(`${haloDiameterPx(40, 40.7295, 17)}px`);
  });

  it("follows a sharper reading, and hides the halo when there is no accuracy (demo spot)", async () => {
    const { rerender } = render(<MapLibreQuestMap {...props()} />);
    await toggleButton();
    const halo = document.querySelector<HTMLElement>('[data-testid="me-halo"]')!;
    rerender(<MapLibreQuestMap {...props({ me: { lat: 40.7295, lng: -73.9965, accuracyM: 8 } })} />);
    expect(halo.style.width).toBe(`${haloDiameterPx(8, 40.7295, 15.6)}px`);

    rerender(<MapLibreQuestMap {...props({ me: { lat: 40.7308, lng: -73.9973 } })} />);
    expect(halo.hidden).toBe(true);
  });

  it("draws the dot above the halo", async () => {
    render(<MapLibreQuestMap {...props()} />);
    await toggleButton();
    const order = [...map().container.children].map((el) => el.firstElementChild?.className || el.className);
    expect(order.indexOf("pin-me-halo")).toBeLessThan(order.indexOf("pin-me"));
  });
});

describe("2D/3D toggle", () => {
  it("replaces MapLibre's compass", async () => {
    render(<MapLibreQuestMap {...props()} />);
    await toggleButton();
    expect(map().addControl).not.toHaveBeenCalled();
  });

  it("works both ways, resets the bearing, and names the action it will take", async () => {
    render(<MapLibreQuestMap {...props()} />);
    const button = await toggleButton();
    expect(button.getAttribute("aria-label")).toBe("Switch to flat 2D view");
    expect(button.textContent).toBe("2D");

    fireEvent.click(button);
    expect(map().easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ pitch: 0, bearing: 0 }));
    expect(map().dragRotate.disable).toHaveBeenCalled();
    expect(map().touchPitch.disable).toHaveBeenCalled();
    expect(map().touchZoomRotate.disableRotation).toHaveBeenCalled();
    expect(button.getAttribute("aria-label")).toBe("Switch to 3D view");
    expect(button.textContent).toBe("3D");

    fireEvent.click(button);
    expect(map().easeTo).toHaveBeenLastCalledWith(expect.objectContaining(VIEW_CAMERA["3d"]));
    expect(map().dragRotate.enable).toHaveBeenCalled();
    expect(map().touchPitch.enable).toHaveBeenCalled();
    expect(button.getAttribute("aria-label")).toBe("Switch to flat 2D view");
  });

  it("keeps the chosen view when flying to another pin", async () => {
    const { rerender } = render(<MapLibreQuestMap {...props()} />);
    fireEvent.click(await toggleButton());
    map().flyTo.mockClear();

    rerender(<MapLibreQuestMap {...props({ selectedId: "p2" })} />);
    expect(map().flyTo).toHaveBeenCalledTimes(1);
    expect(map().flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ pitch: 0, bearing: 0 }));
  });
});
