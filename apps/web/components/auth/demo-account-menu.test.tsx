import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DemoAccountMenu } from "./demo-account-menu";

vi.mock("@clerk/nextjs", () => ({ SignOutButton: ({ children }: { children: React.ReactNode }) => children }));

const trigger = () => screen.getByRole("button", { name: "account" });
const openIt = () => fireEvent.click(trigger());
const expanded = () => trigger().getAttribute("aria-expanded");

describe("DemoAccountMenu", () => {
  it("stays open when a click blurs it without a related target (Safari, macOS Firefox)", () => {
    render(<DemoAccountMenu />);
    openIt();
    fireEvent.blur(trigger(), { relatedTarget: null });
    expect(expanded()).toBe("true");
    expect(screen.getByRole("button", { name: "sign out" })).toBeTruthy();
  });

  it("closes on a press outside, and not on a press inside", () => {
    render(<><DemoAccountMenu /><p>elsewhere</p></>);
    openIt();
    fireEvent.pointerDown(screen.getByRole("button", { name: "sign out" }));
    expect(expanded()).toBe("true");
    fireEvent.pointerDown(screen.getByText("elsewhere"));
    expect(expanded()).toBe("false");
  });

  it("closes when the keyboard moves focus out of it", () => {
    render(<><DemoAccountMenu /><button>next</button></>);
    openIt();
    fireEvent.blur(trigger(), { relatedTarget: screen.getByRole("button", { name: "next" }) });
    expect(expanded()).toBe("false");
  });
});
