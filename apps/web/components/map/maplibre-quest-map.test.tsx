import { act, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckItem, QuestView } from "@/lib/api";
import { haloDiameterPx } from "./accuracy-halo";
import MapLibreQuestMap, { inView, sheetPadding, VIEW_CAMERA } from "./maplibre-quest-map";
import type { QuestMapProps } from "./quest-map";

// The component loads maplibre-gl with a dynamic import(). The first one in a cold test
// worker can take over a second, Testing Library's default wait for findBy/waitFor.
configure({ asyncUtilTimeout: 5000 });

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
    // Where a coordinate lands on screen; tests set it to put a pin under the sheet.
    projected = { x: 200, y: 300 };
    project = vi.fn(() => this.projected);
    moving = false;
    isMoving = () => this.moving;
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
// "You are here" (the halo, then the dot). Its own effect adds them after the map is
// ready, so the toggle can be on screen a moment before they are: wait for them.
const youAreHere = () =>
  waitFor(() => {
    const halo = document.querySelector<HTMLElement>('[data-testid="me-halo"]');
    const dot = document.querySelector<HTMLElement>(".pin-me");
    expect(halo && dot).toBeTruthy();
    return { halo: halo!, dot: dot! };
  });

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

  it("where hit areas overlap, a tap goes to the nearest pin, not the one drawn on top", async () => {
    const onSelect = vi.fn();
    render(<MapLibreQuestMap {...props({ onSelect })} />);
    const top = await screen.findByRole("button", { name: "Cafe Uno" }); // the quest, added last
    const lower = screen.getByRole("button", { name: "Bar Dos" });
    // Centres 20 px apart: their 44 px hit areas overlap between x = 88 and 132.
    const at = (el: HTMLElement, cx: number, cy: number, size: number) =>
      vi.spyOn(el, "getBoundingClientRect").mockReturnValue(new DOMRect(cx - size / 2, cy - size / 2, size, size));
    at(lower, 100, 200, 26);
    at(top, 120, 200, 38);

    // In the overlap, nearer the lower pin: the browser hands the click to the top one.
    fireEvent.click(top, { clientX: 104, clientY: 202, detail: 1 });
    expect(onSelect).toHaveBeenLastCalledWith("p2");

    fireEvent.click(top, { clientX: 117, clientY: 199, detail: 1 });
    expect(onSelect).toHaveBeenLastCalledWith("p1");

    // Enter/Space on the focused pin: no position, so it selects itself.
    fireEvent.click(top, { clientX: 0, clientY: 0, detail: 0 });
    expect(onSelect).toHaveBeenLastCalledWith("p1");
    fireEvent.click(lower, { clientX: 0, clientY: 0, detail: 0 });
    expect(onSelect).toHaveBeenLastCalledWith("p2");
  });

  it("sizes the halo from the reading's accuracy, flat on the map, and re-measures on zoom", async () => {
    render(<MapLibreQuestMap {...props()} />);
    const { halo } = await youAreHere();
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
    const { halo } = await youAreHere();
    rerender(<MapLibreQuestMap {...props({ me: { lat: 40.7295, lng: -73.9965, accuracyM: 8 } })} />);
    expect(halo.style.width).toBe(`${haloDiameterPx(8, 40.7295, 15.6)}px`);

    rerender(<MapLibreQuestMap {...props({ me: { lat: 40.7308, lng: -73.9973 } })} />);
    expect(halo.hidden).toBe(true);
  });

  it("draws the dot above the halo", async () => {
    render(<MapLibreQuestMap {...props()} />);
    await youAreHere();
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

describe("sheet height changes", () => {
  // The map gets ready after an async import, outside act(), so the toggle can be on
  // screen before React has run the first fly-to. Wait for it before clearing spies.
  const firstFlight = async () => {
    await toggleButton();
    await waitFor(() => expect(map().flyTo).toHaveBeenCalled());
  };
  // jsdom has no layout: give the map container a phone-sized box.
  const sized = () => {
    const el = map().getContainer();
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 800 });
    Object.defineProperty(el, "clientWidth", { configurable: true, value: 400 });
  };

  it("doesn't replay the fly-to (which reset zoom and tilt) when only the sheet's height changes", async () => {
    const { rerender } = render(<MapLibreQuestMap {...props()} />);
    await firstFlight();
    sized();
    map().flyTo.mockClear();

    for (const bottomInset of [300, 340, 260]) rerender(<MapLibreQuestMap {...props({ bottomInset })} />);
    expect(map().flyTo).not.toHaveBeenCalled();
    expect(map().easeTo).not.toHaveBeenCalled(); // the pin (y 300) stays clear of the sheet
  });

  it("pans the pin back into view if the sheet grows over it, keeping zoom, tilt and bearing", async () => {
    const { rerender } = render(<MapLibreQuestMap {...props()} />);
    await firstFlight();
    sized();
    map().projected = { x: 200, y: 600 }; // under a 360 px sheet (visible part ends at 800 - 360 = 440)
    map().flyTo.mockClear();

    rerender(<MapLibreQuestMap {...props({ bottomInset: 330 })} />);
    expect(map().flyTo).not.toHaveBeenCalled();
    expect(map().easeTo).toHaveBeenCalledTimes(1);
    const call = map().easeTo.mock.calls[0][0];
    expect(call).toMatchObject({ center: [-73.997, 40.731], padding: sheetPadding(330, 800) });
    expect(call).not.toHaveProperty("zoom");
    expect(call).not.toHaveProperty("pitch");
    expect(call).not.toHaveProperty("bearing");
  });

  it("doesn't cut into a fly-to or a gesture already under way", async () => {
    const { rerender } = render(<MapLibreQuestMap {...props()} />);
    await firstFlight();
    sized();
    map().projected = { x: 200, y: 600 };
    map().moving = true;
    rerender(<MapLibreQuestMap {...props({ bottomInset: 330 })} />);
    expect(map().easeTo).not.toHaveBeenCalled();
  });

  it("pans a pin the open wide-screen sheet now covers to its left, keeping zoom, tilt and bearing", async () => {
    const { rerender } = render(<MapLibreQuestMap {...props()} />);
    await firstFlight();
    sized();
    Object.defineProperty(map().getContainer(), "clientWidth", { configurable: true, value: 1280 });
    map().flyTo.mockClear();
    map().projected = { x: 640, y: 400 }; // behind a card spanning x 352..928
    rerender(<MapLibreQuestMap {...props({ bottomInset: 0, rightInset: 952 })} />);
    expect(map().flyTo).not.toHaveBeenCalled();
    const call = map().easeTo.mock.calls.at(-1)![0];
    expect(call).toMatchObject({ padding: sheetPadding(0, 800, 952) });
    expect(call).not.toHaveProperty("zoom");
  });

  it("uses the latest sheet height on the next fly-to", async () => {
    const { rerender } = render(<MapLibreQuestMap {...props()} />);
    await firstFlight();
    sized();
    rerender(<MapLibreQuestMap {...props({ bottomInset: 200 })} />);
    rerender(<MapLibreQuestMap {...props({ bottomInset: 200, selectedId: "p2" })} />);
    expect(map().flyTo).toHaveBeenLastCalledWith(expect.objectContaining({ padding: sheetPadding(200, 800) }));
  });
});

describe("padding helpers", () => {
  it("leaves room for the sheet, but never more than 45% of the screen", () => {
    expect(sheetPadding(280, 800).bottom).toBe(310);
    expect(sheetPadding(600, 800).bottom).toBe(360);
  });

  it("leaves the right for an open sheet on a wide screen, never less than the usual margin", () => {
    expect(sheetPadding(0, 800, 952)).toEqual({ top: 90, bottom: 30, left: 60, right: 952 });
    expect(sheetPadding(0, 800, 10).right).toBe(60);
  });

  it("tells whether a point is in the visible part", () => {
    const pad = sheetPadding(280, 800); // visible y: 90..490, x: 60..340
    expect(inView({ x: 200, y: 300 }, 400, 800, pad)).toBe(true);
    expect(inView({ x: 200, y: 600 }, 400, 800, pad)).toBe(false);
    expect(inView({ x: 200, y: 50 }, 400, 800, pad)).toBe(false);
    expect(inView({ x: 20, y: 300 }, 400, 800, pad)).toBe(false);
  });
});
