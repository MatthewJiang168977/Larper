import { describe, expect, it } from "vitest";
import { stripUrl } from "./web-analytics";

describe("stripUrl", () => {
  it("drops the query and the fragment, keeps the path", () => {
    const e = stripUrl({
      type: "pageview",
      url: "https://playlarper.com/sign-in/factor-one?__clerk_ticket=abc&redirect_url=%2Fjournal#x",
    });
    expect(e).toEqual({ type: "pageview", url: "https://playlarper.com/sign-in/factor-one" });
  });

  it("leaves a plain URL alone", () => {
    expect(stripUrl({ type: "pageview", url: "https://playlarper.com/journal" }).url).toBe(
      "https://playlarper.com/journal",
    );
  });
});
