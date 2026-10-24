import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DeckItem, QuestView } from "@/lib/api";
import { hoursSearchUrl, QuestSheet } from "./quest-sheet";

const reasons = { liked: [], rarest: null, indie: false };
const place = (id: string, name: string) => ({
  id,
  name,
  lat: 40.73,
  lng: -73.99,
  category: "cafe",
  tags: [],
  distanceM: 100,
  website: null,
  instagram: null,
  phone: null,
});
const quest = (status: QuestView["status"]): QuestView => ({
  id: "q1",
  status,
  score: 1,
  reasons,
  createdAt: "",
  place: place("p1", "Cafe Uno"),
});
const deck: DeckItem[] = [{ score: 0.5, reasons, place: place("p2", "A Very Long Lead Name That Truncates") }];

const sheet = (status: QuestView["status"], onAction = vi.fn()) =>
  render(<QuestSheet quest={quest(status)} deck={deck} selectedId="p1" onSelect={vi.fn()} onAction={onAction} busy={false} />);

describe("QuestSheet", () => {
  it("says 'Not today' (not 'Abandon') on an accepted quest, and sets it aside rather than skipping", () => {
    const onAction = vi.fn();
    sheet("accepted", onAction);
    expect(screen.queryByText("Abandon")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Not today" }));
    expect(onAction).toHaveBeenCalledWith("not-today");
    expect(onAction).not.toHaveBeenCalledWith("skip");
  });

  it("keeps Skip on an offered quest as a skip", () => {
    const onAction = vi.fn();
    sheet("offered", onAction);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onAction).toHaveBeenCalledWith("skip");
  });

  it("gives lead chips a 44 px hit area, truncating inside so it isn't clipped", () => {
    sheet("offered");
    for (const name of ["Quest", "1. A Very Long Lead Name That Truncates"]) {
      const chip = screen.getByRole("button", { name });
      expect(chip.classList).toContain("hit-target");
      expect(chip.classList).not.toContain("truncate"); // overflow: hidden would clip ::before
      expect(chip.querySelector(".truncate")).toBeTruthy();
    }
  });

  it("draws the small print in the label ink", () => {
    sheet("offered");
    expect(screen.getByText(/No opening hours yet/).classList).toContain("text-ink-label");
  });

  it("links 'Check hours' to a maps search for the place, next to the other links, even with no website or phone", () => {
    sheet("offered");
    const link = screen.getByRole("link", { name: "Check hours" });
    expect(link.getAttribute("href")).toBe("https://www.google.com/maps/search/Cafe%20Uno/@40.73,-73.99,18z");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(link.parentElement).toBe(screen.getByRole("link", { name: "Directions" }).parentElement);
  });

  it("shows 'Check hours' on an accepted quest and on a lead too", () => {
    const { unmount } = sheet("accepted");
    expect(screen.getByRole("link", { name: "Check hours" })).toBeTruthy();
    unmount();
    render(<QuestSheet quest={quest("offered")} deck={deck} selectedId="p2" onSelect={vi.fn()} onAction={vi.fn()} busy={false} />);
    expect(screen.getByRole("link", { name: "Check hours" }).getAttribute("href")).toContain(
      "/search/A%20Very%20Long%20Lead%20Name%20That%20Truncates/@",
    );
  });

  it("escapes names that would break the URL path", () => {
    expect(hoursSearchUrl({ name: "Joe's Pizza / Bar #2 & Co?", lat: 40.7, lng: -74 })).toBe(
      "https://www.google.com/maps/search/Joe's%20Pizza%20%2F%20Bar%20%232%20%26%20Co%3F/@40.7,-74,18z",
    );
  });
});
