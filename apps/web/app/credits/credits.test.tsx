import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CreditsPage from "./page";

vi.mock("@/app/larper-os", () => ({ larperOsClassName: "larper-os" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const href = (name: string) => screen.getByRole("link", { name }).getAttribute("href");

describe("Credits", () => {
  it("shows one Credits heading in the OS shell, with a way back", () => {
    render(<CreditsPage />);
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings.map((h) => h.textContent)).toEqual(["Credits"]);
    expect(screen.getByRole("link", { name: "← Larper" }).getAttribute("href")).toBe("/");
  });

  it("gives the map's OpenStreetMap, OpenMapTiles and OpenFreeMap credits", () => {
    render(<CreditsPage />);
    const map = screen.getByRole("region", { name: "Map" });
    expect(map.textContent).toContain("OpenStreetMap contributors");
    expect(map.textContent).toContain("Open Database License (ODbL)");
    expect(map.textContent).toContain("© OpenMapTiles");
    expect(href("OpenStreetMap contributors")).toBe("https://www.openstreetmap.org/copyright");
    expect(href("OpenFreeMap")).toBe("https://openfreemap.org/");
  });

  it("credits Overture for places, with its licences and attribution page", () => {
    render(<CreditsPage />);
    const places = screen.getByRole("region", { name: "Places" });
    expect(places.textContent).toContain("Overture Maps Foundation");
    for (const licence of ["CDLA Permissive 2.0", "Apache 2.0 (Foursquare)", "CC0 1.0 (AllThePlaces)"]) {
      expect(places.textContent).toContain(licence);
    }
    expect(href("Overture's attribution page")).toBe("https://docs.overturemaps.org/attribution/");
  });

  it("credits the fonts under the Open Font License", () => {
    render(<CreditsPage />);
    const type = screen.getByRole("region", { name: "Type" });
    expect(type.textContent).toContain("Atkinson Hyperlegible Next");
    expect(type.textContent).toContain("Jersey 20");
    expect(type.textContent).toContain("SIL Open Font License 1.1");
  });

  it("opens every external credit over https", () => {
    render(<CreditsPage />);
    for (const a of screen.getAllByRole("link")) {
      const h = a.getAttribute("href") ?? "";
      if (h.startsWith("/")) continue;
      expect(h).toMatch(/^https:\/\//);
    }
  });
});
