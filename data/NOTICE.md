# Data in this folder

## Overture places (`*.parquet`)

`extract_overture.py` writes Overture Maps Places data here, for example
`nyc.parquet`. The parquet files are gitignored and never committed, but rows from
these extracts are loaded into Larper's database and shown in the app.

- Source: [Overture Maps Foundation](https://overturemaps.org/), Places theme, the
  release named in `extract_overture.py` (`RELEASE`).
- Licences: each Places provider has its own. Most are under
  [CDLA Permissive 2.0](https://cdla.dev/permissive-2-0/); Foursquare's are under
  [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) with
  [this notice](https://opensource.foursquare.com/places-notice-txt/); AllThePlaces is
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). The full list of
  providers and their credit lines is on
  [Overture's attribution page](https://docs.overturemaps.org/attribution/).
- Overture states that the Places theme contains no OpenStreetMap data, so no ODbL
  obligations come with it. See `docs/decisions/opening-hours-sources.md` before adding
  any OpenStreetMap-derived data.
- Credit in the app: `apps/web/app/credits/page.tsx` (`/credits`). Keep it in step
  with this file.

## Focus neighborhoods (`focus-neighborhoods.geojson`)

Three approximate polygons drawn by hand for Larper (East Village, Union Square,
Greenwich Village). No third-party data.
