# Opening-hours pilot: how to run the two tools

Two tools for the hand-verified opening hours the
[sources decision](../decisions/opening-hours-sources.md) approved (source `manual`): one
exports a CSV of places to look up, one imports the CSV once you've filled it in.
**No OpenStreetMap data, ever**: the `opening_hours` column is the OSM *syntax* only
(`Mo-Fr 09:00-17:00; Sa 10:00-14:00`), typed by you from the door or the venue's own site.

**The CSVs and the `pilot/` folder never go in the repo.** `pilot/` is gitignored; don't
`git add -f` anything from it.

## 1. Export the candidates (read-only)

```bash
DATABASE_URL=postgres://USER:PASS@HOST:PORT/larper bash scripts/hours-pilot-candidates
# -> pilot/hours-candidates-YYYY-MM-DD.csv   (options: --out FILE, --per-area N [50])
```

- `DATABASE_URL`: any role that can `SELECT` from `places` and `place_hours_facts`
  (`larper_api` can). The tool runs one transaction with `SET TRANSACTION READ ONLY`, so
  the database refuses any write. For the production database you reach it the way you
  reach it for `load-places` (port-forward, then the URL); that is your call, not the tool's.
- It picks the places inside the three polygons in `data/focus-neighborhoods.geojson`
  (approximate East Village, Union Square, Greenwich Village), applies the quest trust
  gate (`apps/api/src/quests/eligibility.ts`: confidence, blocked categories, same-name
  dedupe; plus `location_suspect IS NULL`), skips places that already have a `manual`
  schedule, ranks the rest with the quest score without any personal taste
  (rarity x not-a-chain x confidence) and keeps the top 50 of each neighborhood (150 total).
- Columns: `place_id, neighborhood, name, address, website, phone, opening_hours, source,
  date_checked`. `address` is blank: the places table has no address column. Fill in the
  last three: `opening_hours` in OSM syntax (24-hour times; `Mo-Su 17:00-02:00`; `PH off`),
  `source` as the website URL or `seen on the door`, `date_checked` as `YYYY-MM-DD`.
  Leave a row's three columns empty to skip it.
- Editing in Excel: save as "CSV UTF-8 (comma delimited)". The importer strips Excel's BOM
  and accepts `M/D/YYYY`, which US-locale Excel uses. Slash dates are always read month-first.
  For example, `3/4/2026` means March 4. Use `YYYY-MM-DD` to avoid ambiguity and check the
  interpreted dates in the dry-run output before applying. Correct any semicolon-separated
  files or `24/7` values that Excel converted to dates before importing.
  A field starting with `'` in the CSV is the exporter
  keeping Overture text from running as a formula; the importer only reads `place_id` and
  the three columns you fill in.

## 2. Import the filled-in CSV

```bash
cd workers
# dry run (the default): reads, prints what would be inserted or updated, writes nothing
DATABASE_URL=postgres://... go run ./cmd/hours-pilot-import -in ../pilot/hours-candidates-YYYY-MM-DD.csv
# the same, writing
DATABASE_URL=postgres://... go run ./cmd/hours-pilot-import -in ../pilot/hours-candidates-YYYY-MM-DD.csv -apply
```

- `DATABASE_URL` for `-apply` needs `INSERT` and `UPDATE` on `place_hours_facts` and
  `SELECT` on `places`: the table owner (the migrate role). `larper_api` can only insert,
  and `larper_ingest` has no grant on the table, on purpose (migration 0018). The dry run
  only needs `SELECT`.
- Every row is checked first with the same parser the workers use (`workers/internal/hours`);
  if any row is bad, nothing is written and every problem is listed with its line number:
  unparseable or only partly understood hours, a source that is neither an http(s) URL nor
  `seen on the door`, an invalid date or a date after today in America/New_York,
  a repeated `place_id`, a place that doesn't exist, or a `name` that isn't that place's
  name in the database (case, spacing and curly quotes aside; leave the exported `name`
  column in, so a mistyped `place_id` can't put hours on the wrong venue). The dry run
  prints each place's database name next to its id.
- Rows land as `kind='schedule'`, `service='regular'`, `source='manual'`, confidence 0.9,
  `source_url` = your URL (NULL for the door), `fetched_at` = `date_checked` at noon New York,
  `raw` = the hours text as typed (for the door, plus a second line `[seen on the door]`),
  `schedule` = the normalized v1 jsonb ([SCHEDULE.md](../../workers/internal/hours/SCHEDULE.md)).
  Re-running updates the same rows, so fixing a typo and importing again is safe.
- `-apply` is one transaction: all rows or none.
