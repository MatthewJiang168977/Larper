import type { Metadata } from "next";
import Link from "next/link";
import { LarperOsPageShell } from "@/components/larper-os/page-shell";

export const metadata: Metadata = { title: "Credits · Larper" };

type Credit = { name: string; href: string; what: string; license: { name: string; href: string }[] };

// Keep in step with components/map/journal-style.ts (tiles, label fonts), data/NOTICE.md (places),
// docs/decisions/opening-hours-sources.md (hours), app/larper-os.ts and app/layout.tsx (fonts).
const GROUPS: { title: string; credits: Credit[] }[] = [
  {
    title: "Map",
    credits: [
      {
        name: "OpenStreetMap contributors",
        href: "https://www.openstreetmap.org/copyright",
        what: "The streets, parks, water and buildings on the map.",
        license: [{ name: "Open Database License (ODbL)", href: "https://opendatacommons.org/licenses/odbl/" }],
      },
      {
        name: "OpenMapTiles",
        href: "https://www.openmaptiles.org/",
        what: "The vector tile schema the map is drawn from.",
        license: [{ name: "© OpenMapTiles", href: "https://www.openmaptiles.org/" }],
      },
      {
        name: "OpenFreeMap",
        href: "https://openfreemap.org/",
        what: "Serves the map tiles and the fonts for map labels, free and without a key.",
        license: [{ name: "MIT", href: "https://github.com/hyperknot/openfreemap/blob/main/LICENSE.md" }],
      },
      {
        name: "Noto Sans",
        href: "https://fonts.google.com/noto/specimen/Noto+Sans",
        what: "The street and place labels on the map, served by OpenFreeMap.",
        license: [{ name: "SIL Open Font License 1.1", href: "https://openfontlicense.org/" }],
      },
      {
        name: "MapLibre GL JS",
        href: "https://maplibre.org/",
        what: "Draws the map in your browser.",
        license: [{ name: "BSD 3-Clause", href: "https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt" }],
      },
    ],
  },
  {
    title: "Places",
    credits: [
      {
        name: "Overture Maps Foundation",
        href: "https://overturemaps.org/",
        what: "The places quests send you to: names, categories, locations and websites, from Overture's Places data. Overture lists each data provider and its licence on its attribution page.",
        license: [
          { name: "CDLA Permissive 2.0", href: "https://cdla.dev/permissive-2-0/" },
          { name: "Apache 2.0 (Foursquare)", href: "https://opensource.foursquare.com/places-notice-txt/" },
          { name: "CC0 1.0 (AllThePlaces)", href: "https://creativecommons.org/publicdomain/zero/1.0/" },
          { name: "Overture's attribution page", href: "https://docs.overturemaps.org/attribution/" },
        ],
      },
    ],
  },
  {
    title: "Type",
    credits: [
      {
        name: "Atkinson Hyperlegible Next",
        href: "https://www.brailleinstitute.org/freefont/",
        what: "The body text, by the Braille Institute.",
        license: [{ name: "SIL Open Font License 1.1", href: "https://openfontlicense.org/" }],
      },
      {
        name: "Jersey 20, Fraunces and JetBrains Mono",
        href: "https://fonts.google.com/",
        what: "Headings, display type and figures. From Google Fonts, served by Larper itself.",
        license: [{ name: "SIL Open Font License 1.1", href: "https://openfontlicense.org/" }],
      },
    ],
  },
];

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export default function CreditsPage() {
  return (
    <LarperOsPageShell title="Credits" wide>
      <div className="larper-os-privacy">
        <Link href="/" className="larper-os-page-link justify-self-start">
          ← Larper
        </Link>
        <p>Larper is built on open data and open software. Thank you to everyone below.</p>

        {GROUPS.map((g) => (
          <section key={g.title} aria-labelledby={`credits-${slug(g.title)}`} className="larper-os-privacy">
            <h2 id={`credits-${slug(g.title)}`}>{g.title}</h2>
            <ul className="larper-os-privacy-groups larper-os-credits" role="list">
              {g.credits.map((c) => (
                <li key={c.name}>
                  <h3>
                    <a href={c.href} className="larper-os-credit-link">
                      {c.name}
                    </a>
                  </h3>
                  <p className="mt-1 text-sm">{c.what}</p>
                  <ul className="larper-os-credit-licences text-sm" role="list" aria-label={`${c.name} licences`}>
                    {c.license.map((l) => (
                      <li key={l.name}>
                        <a href={l.href} className="larper-os-credit-link">
                          {l.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        ))}

        <p className="text-sm">
          Opening hours come from Larper itself: checked by hand, or confirmed by people who checked in and answered
          “was it open?”. The map&apos;s corner credit links to its sources too.
        </p>
      </div>
    </LarperOsPageShell>
  );
}
