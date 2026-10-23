import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { DemoPanel, demoError, TryDemoButton } from "./try-demo";

// Clerk's signal-based sign-in, faked: ticket() completes (or fails), finalize() navigates.
const signIn = {
  status: "needs_identifier" as string,
  ticket: vi.fn(),
  finalize: vi.fn(),
};
const push = vi.fn();
vi.mock("@clerk/nextjs", () => ({ useSignIn: () => ({ signIn, errors: {}, fetchStatus: "idle" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const demoTicket = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  demoTicket: () => demoTicket(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  signIn.status = "needs_identifier";
  signIn.ticket.mockImplementation(async () => {
    signIn.status = "complete";
    return { error: null };
  });
  signIn.finalize.mockImplementation(async ({ navigate }) => {
    await navigate({ session: {}, decorateUrl: (u: string) => u });
    return { error: null };
  });
});

describe("TryDemoButton", () => {
  it("redeems a ticket from the API, then finalizes and goes home", async () => {
    demoTicket.mockResolvedValue("ticket-1");
    render(<TryDemoButton />);
    fireEvent.click(screen.getByRole("button", { name: "Try the demo" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    expect(signIn.ticket).toHaveBeenCalledWith({ ticket: "ticket-1" });
    expect(signIn.finalize).toHaveBeenCalledTimes(1);
  });

  it("says why when the API refuses, and lets the visitor try again", async () => {
    demoTicket.mockRejectedValue(new ApiError("Too many requests.", 429, "http", "rate_limited", 42));
    render(<TryDemoButton />);
    fireEvent.click(screen.getByRole("button", { name: "Try the demo" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Try again in 42 s.");
    expect(signIn.ticket).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Try the demo" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("doesn't finalize a sign-in that Clerk didn't complete", async () => {
    demoTicket.mockResolvedValue("ticket-2");
    signIn.ticket.mockResolvedValue({ error: { code: "ticket_invalid" } });
    render(<TryDemoButton />);
    fireEvent.click(screen.getByRole("button", { name: "Try the demo" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't start the demo.");
    expect(signIn.finalize).not.toHaveBeenCalled();
  });
});

describe("DemoPanel", () => {
  it("shows the demo only when sign-ups are restricted, and never a password", () => {
    const { container, rerender } = render(<DemoPanel signUpMode="public" />);
    expect(container.textContent).toBe("");
    rerender(<DemoPanel signUpMode="restricted" />);
    expect(screen.getByRole("region", { name: "Demo" }).textContent).toContain("Try the demo");
    expect(container.textContent?.toLowerCase()).not.toContain("password:");
  });
});

describe("demoError", () => {
  it("has plain words for each failure", () => {
    expect(demoError(new ApiError("x", 404))).toBe("The demo isn't available here.");
    expect(demoError(new ApiError("x", 429))).toMatch(/in a minute/);
    expect(demoError(new ApiError("x", 503))).toBe("Something went wrong on our end.");
    expect(demoError(new Error("clerk"))).toBe("Couldn't start the demo. Try again.");
  });
});
