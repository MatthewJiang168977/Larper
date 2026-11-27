import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { CurationPlace } from "./api";
import { CurationPage } from "./curation-page";

const api = vi.fn();
vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), useApi: () => api }));

const place = (id: string, name: string): CurationPlace => ({
  id,
  name,
  category: "coffee_shop",
  lat: 40.7265,
  lng: -73.984,
  address: null,
  website: "https://example.com",
  instagram: null,
  verdict: null,
  note: null,
  hours: [],
  reports: [],
});
const list = {
  areas: [{ slug: "east-village", name: "East Village" }],
  area: "east-village",
  total: 2,
  places: [place("1", "First Place"), place("2", "Second Place")],
};

const key = async (k: string) => {
  await act(async () => {
    fireEvent.keyDown(document.body, { key: k });
  });
};
const current = () => document.querySelector('[aria-current="true"] h2')?.textContent;
const posted = () => api.mock.calls.filter(([, init]) => init?.method === "POST").map(([path, init]) => [path, JSON.parse(init.body)]);

beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (!init) return structuredClone(list);
    const body = JSON.parse(String(init.body));
    if (body.kind === "note") return { note: body.note ? { text: body.note, at: "2026-11-26T12:00:00Z" } : null };
    return { verdict: { kind: body.kind, at: "2026-11-26T12:00:00Z", expired: false } };
  });
});
afterEach(cleanup);

const open = async () => {
  render(<CurationPage />);
  await act(async () => {});
};

describe("CurationPage", () => {
  it("lists one neighbourhood and says when there is no address", async () => {
    await open();
    expect(api).toHaveBeenCalledWith("/admin/places?area=east-village");
    expect(current()).toBe("First Place");
    expect(screen.getAllByText(/no street address on file/)).toHaveLength(2);
  });

  it("shows only not found to someone the API doesn't know as an admin", async () => {
    api.mockRejectedValue(new ApiError("Cannot GET /admin/places", 404));
    await open();
    expect(screen.getByRole("heading").textContent).toBe("Not found");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("records a verdict from the keyboard and moves to the next place", async () => {
    await open();
    await key("g");
    expect(posted()).toEqual([["/admin/places/1/facts", { kind: "great" }]]);
    expect(current()).toBe("Second Place");
    await key("c");
    expect(posted()[1]).toEqual(["/admin/places/2/facts", { kind: "closed" }]);
  });

  it("moves with j and k without recording", async () => {
    await open();
    await key("j");
    expect(current()).toBe("Second Place");
    await key("k");
    expect(current()).toBe("First Place");
    expect(posted()).toEqual([]);
  });

  it("takes a note of at most 140 characters, and keys typed in it are not shortcuts", async () => {
    await open();
    await key("n");
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.maxLength).toBe(140);
    fireEvent.keyDown(input, { key: "c" });
    fireEvent.change(input, { target: { value: "ask for the back room" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });
    expect(posted()).toEqual([["/admin/places/1/facts", { kind: "note", note: "ask for the back room" }]]);
    expect(current()).toBe("First Place");
    expect(screen.getByText("note: ask for the back room")).toBeTruthy();
  });

  it("keeps the place and shows the API's words when a save is refused", async () => {
    await open();
    api.mockRejectedValueOnce(new ApiError('"9am": use 24-hour times', 400));
    await key("h");
    await act(async () => {
      fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    });
    expect(screen.getByRole("alert").textContent).toContain("24-hour");
    expect(screen.getByRole("textbox")).toBeTruthy();
  });
});
