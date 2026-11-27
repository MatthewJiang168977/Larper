import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorthItQuestion } from "./worth-it-question";

afterEach(cleanup);

describe("WorthItQuestion", () => {
  it("offers yes, meh, no and skip", () => {
    render(<WorthItQuestion answer={null} onAnswer={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.getByRole("group", { name: "worth it?" })).toBeTruthy();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["yes", "meh", "no", "skip"]);
  });

  it("sends the answer and thanks once saved", async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(<WorthItQuestion answer={null} onAnswer={onAnswer} onSkip={vi.fn()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "meh" }));
    });
    expect(onAnswer).toHaveBeenCalledWith("meh");
    expect(screen.getByRole("status").textContent).toBe("thanks, noted");
  });

  it("skips without answering", () => {
    const onAnswer = vi.fn();
    const onSkip = vi.fn();
    render(<WorthItQuestion answer={null} onAnswer={onAnswer} onSkip={onSkip} />);
    fireEvent.click(screen.getByRole("button", { name: "skip" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
