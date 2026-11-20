import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { JournalView } from "@/components/larper-os/journal";
import { OSWindow } from "@/components/larper-os/primitives";
import PageError from "./error";
import GlobalError from "./global-error";
import NotFound from "./not-found";

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException }));
vi.mock("@/app/larper-os", () => ({ larperOsClassName: "larper-os" }));

const failure = () => Object.assign(new Error("private error message"), { digest: "private-digest" });

it("does not render a title when an OS window has none", () => {
  const { container } = render(<OSWindow titleAs="h1">window content</OSWindow>);
  expect(screen.getByText("window content")).toBeTruthy();
  expect(container.querySelector(".larper-os-titlebar")).toBeNull();
  expect(screen.queryByRole("heading")).toBeNull();
});

it("keeps field journal as the journal's sole h1", () => {
  render(<JournalView entries={[]} error={null} retry={vi.fn()} />);
  expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual(["field journal"]);
});

it("shows a single 404 heading and a link back to the map", () => {
  render(<NotFound />);
  expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual(["page not found"]);
  expect(screen.getByRole("link", { name: "back to the map" }).getAttribute("href")).toBe("/");
});

it("reports a page error without exposing its details and lets the user retry", () => {
  const error = failure();
  const retry = vi.fn();
  render(<PageError error={error} retry={retry} />);
  expect(captureException).toHaveBeenCalledWith(error);
  expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual(["something went wrong."]);
  expect(screen.getByRole("main").textContent).not.toMatch(/private error message|private-digest/);
  expect(screen.getByRole("link", { name: "back to the map" }).getAttribute("href")).toBe("/");
  fireEvent.click(screen.getByRole("button", { name: "try again" }));
  expect(retry).toHaveBeenCalledOnce();
});

it("provides its own OS document, reports the global error and supports retry", async () => {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  const root = createRoot(doc);
  const error = failure();
  const retry = vi.fn();
  try {
    await act(() => root.render(<GlobalError error={error} retry={retry} />));
    const body = within(doc.body);
    expect(doc.documentElement.lang).toBe("en");
    expect(doc.body.classList.contains("larper-os")).toBe(true);
    expect(captureException).toHaveBeenCalledWith(error);
    expect(body.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual(["something went wrong."]);
    expect(doc.body.textContent).not.toMatch(/private error message|private-digest/);
    expect(body.getByRole("link", { name: "back to the map" }).getAttribute("href")).toBe("/");
    fireEvent.click(body.getByRole("button", { name: "try again" }));
    expect(retry).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
    frame.remove();
  }
});
