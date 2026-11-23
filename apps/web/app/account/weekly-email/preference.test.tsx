import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WeeklyEmailPreference } from "./preference";

const api = vi.hoisted(() => vi.fn());
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ sessionId: "fixture-session" }) }));
vi.mock("@/lib/api", () => ({ useApi: () => api, describeError: () => "Could not save." }));

afterEach(() => {
  cleanup();
  api.mockReset();
});

it("reads the preference and waits for an explicit subscribe click before sending a write", async () => {
  api.mockResolvedValueOnce({ enabled: false }).mockResolvedValueOnce({ enabled: true });
  render(<WeeklyEmailPreference />);
  const subscribe = await screen.findByRole("button", { name: "subscribe" });
  expect(api).toHaveBeenCalledTimes(1);
  fireEvent.click(subscribe);
  await screen.findByRole("button", { name: "unsubscribe" });
  expect(api).toHaveBeenLastCalledWith("/me/weekly-email", {
    method: "PUT", body: JSON.stringify({ enabled: true }),
  });
});
