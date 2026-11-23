import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DemoAccountMenu } from "./demo-account-menu";

vi.mock("@clerk/nextjs", () => ({ SignOutButton: ({ children }: { children: React.ReactNode }) => children }));

const menu = () => screen.getByText("account", { selector: "summary" }).closest("details") as HTMLDetailsElement;
const openIt = () => act(() => {
  menu().open = true;
  menu().dispatchEvent(new Event("toggle"));
});

describe("DemoAccountMenu", () => {
  it("stays open when a click blurs it without a related target (Safari, macOS Firefox)", () => {
    render(<DemoAccountMenu />);
    openIt();
    fireEvent.blur(menu().querySelector("summary")!, { relatedTarget: null });
    expect(menu().open).toBe(true);
    expect(screen.getByRole("button", { name: "sign out" })).toBeTruthy();
  });

  it("closes on a press outside, and not on a press inside", () => {
    render(<><DemoAccountMenu /><p>elsewhere</p></>);
    openIt();
    fireEvent.pointerDown(screen.getByRole("button", { name: "sign out" }));
    expect(menu().open).toBe(true);
    fireEvent.pointerDown(screen.getByText("elsewhere"));
    expect(menu().open).toBe(false);
  });

  it("closes when the keyboard moves focus out of it", () => {
    render(<><DemoAccountMenu /><button>next</button></>);
    openIt();
    fireEvent.blur(menu().querySelector("summary")!, { relatedTarget: screen.getByRole("button", { name: "next" }) });
    expect(menu().open).toBe(false);
  });
});
