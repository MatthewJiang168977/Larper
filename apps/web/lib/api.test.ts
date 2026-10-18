import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, describeError, useApi } from "./api";

vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: async () => "tok" }) }));

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

const call = (path = "/quests/today") => renderHook(() => useApi()).result.current(path);
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("useApi", () => {
  it("returns the JSON body and sends the token", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: 1 }));
    await expect(call()).resolves.toEqual({ ok: 1 });
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("throws an ApiError with the API's message and status", async () => {
    fetchMock.mockResolvedValue(json(422, { message: "You're 110 m away" }));
    await expect(call()).rejects.toMatchObject({ name: "ApiError", status: 422, message: "You're 110 m away" });
  });

  it("joins Nest's validation messages", async () => {
    fetchMock.mockResolvedValue(json(400, { message: ["lat must be a number", "lng must be a number"] }));
    await expect(call()).rejects.toMatchObject({ message: "lat must be a number; lng must be a number" });
  });

  it("reports a network failure as status 0", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(call()).rejects.toMatchObject({ status: 0, kind: "network" });
  });

  it("gives up after the request timeout", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    // Like fetch: reject once the signal aborts, or at once if it already has.
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_, reject) => {
          const abort = () => reject(new DOMException("timeout", "TimeoutError"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort);
        }),
    );
    const pending = call();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 0, kind: "timeout" });
  });
});

describe("describeError", () => {
  it("keeps the API's words for 4xx, and uses plain copy otherwise", () => {
    expect(describeError(new ApiError("You're 110 m away", 422))).toBe("You're 110 m away");
    expect(describeError(new ApiError("Internal server error", 500))).toBe("Something went wrong on our end.");
    expect(describeError(new ApiError("x", 0, "network"))).toBe("Can't reach the server. Check your connection.");
    expect(describeError(new ApiError("x", 0, "timeout"))).toBe("The server is taking too long to answer.");
    expect(describeError(new Error("weird"))).toBe("Something went wrong.");
  });
});
