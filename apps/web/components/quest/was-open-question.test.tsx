import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WasOpenQuestion } from "./was-open-question";

afterEach(cleanup);

const names = () => screen.getAllByRole("button").map((b) => b.textContent);

describe("WasOpenQuestion", () => {
  it("is a labelled group of three buttons, and takes no focus", () => {
    render(<WasOpenQuestion answer={null} onAnswer={vi.fn()} />);
    expect(screen.getByRole("group", { name: "was it open?" })).toBeTruthy();
    expect(names()).toEqual(["yes", "no", "didn't check"]);
    expect(document.activeElement).toBe(document.body);
  });

  it.each([
    ["yes", "yes"],
    ["no", "no"],
    ["didn't check", "didnt_check"],
  ])("sends %s and thanks at once", async (label, answer) => {
    let finish!: () => void;
    const onAnswer = vi.fn(() => new Promise<void>((r) => (finish = r)));
    render(<WasOpenQuestion answer={null} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(onAnswer).toHaveBeenCalledWith(answer);
    // Before the API has answered.
    expect(screen.getByRole("status").textContent).toBe("thanks, noted");
    expect(screen.queryByRole("button")).toBeNull();
    await act(async () => finish());
    expect(screen.getByRole("status").textContent).toBe("thanks, noted");
  });

  it("can't be answered twice while sending", () => {
    const onAnswer = vi.fn(() => new Promise<void>(() => {}));
    render(<WasOpenQuestion answer={null} onAnswer={onAnswer} />);
    const yes = screen.getByRole("button", { name: "yes" });
    fireEvent.click(yes);
    fireEvent.click(yes);
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it("moves focus to the thanks only if the pressed button had it", async () => {
    render(<WasOpenQuestion answer={null} onAnswer={vi.fn().mockResolvedValue(undefined)} />);
    const yes = screen.getByRole("button", { name: "yes" });
    yes.focus();
    fireEvent.click(yes);
    await act(async () => {});
    const thanks = screen.getByRole("status");
    expect(thanks.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(thanks);
  });

  it("leaves focus alone when it was elsewhere", async () => {
    render(
      <>
        <button>elsewhere</button>
        <WasOpenQuestion answer={null} onAnswer={vi.fn().mockResolvedValue(undefined)} />
      </>,
    );
    screen.getByRole("button", { name: "elsewhere" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "no" }));
    await act(async () => {});
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "elsewhere" }));
  });

  it("on failure puts the question back with a short error, and lets them retry", async () => {
    const onAnswer = vi.fn().mockRejectedValueOnce(new Error("nope")).mockResolvedValue(undefined);
    render(<WasOpenQuestion answer={null} onAnswer={onAnswer} />);
    const no = screen.getByRole("button", { name: "no" });
    no.focus();
    fireEvent.click(no);
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toBe("couldn't save that, try again");
    expect(names()).toEqual(["yes", "no", "didn't check"]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "no" }));
    fireEvent.click(screen.getByRole("button", { name: "yes" }));
    await act(async () => {});
    expect(onAnswer).toHaveBeenLastCalledWith("yes");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("thanks, noted");
  });

  it("shows the thanks for an answer that's already saved", () => {
    render(<WasOpenQuestion answer="yes" onAnswer={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe("thanks, noted");
    expect(screen.queryByRole("group")).toBeNull();
  });
});
