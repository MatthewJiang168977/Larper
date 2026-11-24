import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToastProvider, useToast } from "./toaster";

function Trigger() {
  const toast = useToast();
  return <button onClick={() => toast("saved larper-export.json.")}>go</button>;
}

describe("toasts", () => {
  it("announce politely, look like a small window, and go away on their own", { timeout: 20000 }, async () => {
    render(<ToastProvider><Trigger /></ToastProvider>);
    const region = document.querySelector('[role="status"]')!;
    expect(region.getAttribute("aria-live")).toBe("polite");
    // Nothing of the toast windows is loaded until the first toast.
    expect(region.querySelector(".larper-toast")).toBeNull();
    fireEvent.click(screen.getByText("go"));
    await screen.findByText("saved larper-export.json.", {}, { timeout: 10000 });
    expect(region.querySelector(".larper-os-titlebar")).toBeTruthy();
    await waitFor(() => expect(region.querySelector(".larper-toast")).toBeNull(), { timeout: 8000 });
  });

  it("does nothing outside a provider", () => {
    render(<Trigger />);
    expect(() => fireEvent.click(screen.getByText("go"))).not.toThrow();
  });
});
