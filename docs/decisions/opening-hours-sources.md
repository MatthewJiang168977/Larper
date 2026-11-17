# Opening hours: where they come from

- **Status:** proposed, 2026-11-16. Nothing here is approved. **No third-party hours
  data is to be loaded into any real database until the owner approves the licensing.**
- **Scope:** which sources Larper may take opening hours from, at $0 in API fees, and
  what each one obliges us to do.
- **Not legal advice.** The OpenStreetMap questions at the end need someone qualified,
  or a decision to take the conservative route described below.

## Context

Larper has no opening hours for any place. That is the largest trust gap in the
product: a quest can send someone to a locked door. The goal for now is a few hundred
places in three neighborhoods (East Village, Union Square, Greenwich Village), not the
city.

Places come from Overture's Places theme. Overture states that theme contains no
OpenStreetMap data and has no hours field; `operating_status` "is not an indication of
opening hours" ([places guide](https://docs.overturemaps.org/guides/places/),
[schema](https://docs.overturemaps.org/schema/reference/places/place/),
[attribution](https://docs.overturemaps.org/attribution/)). So Larper's place data has
no ODbL content today. Whatever we choose for hours would be the first.

## Recommendation

Use, in this order:

1. **Check-in confirmations** ("Was it open?"). Our own data, no licence, and the only
   source that says a place was open at a real moment. Build now.
2. **Hand-verified hours** for the focus neighborhoods, recorded as source `manual`
   with the URL or "seen on the door". Facts collected ourselves; slow, but 150 places
   is an afternoon or two, and it is the only source we fully trust. Start now.
3. **The venue's own website** (schema.org markup), fetched politely, only for focus-area
   places that already have a website on file. **Measure first:** before building a
   pipeline, fetch those few hundred home pages once and count how many carry hours
   markup. If it's under a third, don't build it; keep verifying by hand.
4. **NYC Open Data, for closures, not hours.** The inspection and licence datasets
   don't have hours but do say whether a business is still operating. Later.

Do **not** use for now:

- **OpenStreetMap.** It has the best coverage by far, and it is the one source with an
  unresolved licence question for how we'd use it. See below for the route that would
  make it usable.
- **AllThePlaces.** Clean licence, but chains only, and Larper already ranks chains down.

## The sources

### OpenStreetMap `opening_hours`

**What it has.** New York State has 39,431 objects with an `opening_hours` tag
([taginfo](https://taginfo.geofabrik.de/north-america/us/new-york/api/4/key/stats?key=opening_hours)).
A live count for Manhattan food and drink suggested roughly 57% of 7,307 venues carry
hours; treat that as indicative, the query was rate-limited before it could be
confirmed. No count was obtained for the three neighborhoods. Free to download: the
state extract is 475 MB, updated about daily
([Geofabrik](https://download.geofabrik.de/north-america/us/new-york.html)).

**Licence.** ODbL 1.0. Three things follow.

- *Attribution.* Showing OSM-derived hours needs a visible credit to OpenStreetMap
  linked to openstreetmap.org/copyright, near the content and without interaction
  ([Attribution Guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)).
  Easy: the hours line says "from OpenStreetMap" with that link.
- *Share-alike.* It applies on public use of a database derived from OSM, not to
  private use ([Licence FAQ](https://osmfoundation.org/wiki/Licence/Licence_and_Legal_FAQ)).
  Larper's database is private but the site shows facts from it to the public, and the
  guidelines don't say plainly which side of the line a place card falls on.
- *Does a separate table help?* Less than hoped. The
  [Collective Database Guideline](https://osmfoundation.org/wiki/Licence/Community_Guidelines/Collective_Database_Guideline_Guideline)
  treats OSM and non-OSM data as independent when, within a region, each *property* is
  "either all OSM or all non-OSM". A join key between the tables counts as a
  reference, so separation alone isn't a safe harbour. Two consequences for us:
  - Keeping OSM hours in their own table, matched to Overture places, looks like the
    guideline's "add a property from another source" case *only if all hours in the
    region come from OSM*. Mixing OSM hours with website or hand-verified hours for
    the same property breaks that test.
  - Matching OSM venues to Overture venues by name and location is close to the
    guideline's example of merging and de-duplicating a restaurant list, which it
    says is **not covered**.
- *Size.* Systematically extracting the eating places of an area is "substantial"
  under the [Substantial Guideline](https://osmfoundation.org/wiki/Licence/Community_Guidelines/Substantial_-_Guideline);
  a few hundred chosen systematically would likely count.

**The route that would make it usable.** Stop trying to avoid share-alike and accept
it: publish the OSM-derived hours table and the OSM-to-place match under ODbL (a file
in this public repository), credit OpenStreetMap on every place card that uses it, and
keep those rows in their own table so what is owed is obvious. The remaining risk is
whether that pulls the matched Overture rows into the obligation too. That is the
question to settle before saying yes.

**Other costs.** The syntax is large (holidays, sunrise, week numbers, fallbacks); the
reference parser is JavaScript and LGPL-3.0
([opening_hours.js](https://github.com/opening-hours/opening_hours.js)); no mature Go
parser was found, so we write the subset we need. Matching errors put the wrong hours
on the wrong place, which is worse than no hours.

### The venue's own website (schema.org)

**What it has.** `openingHours` or `openingHoursSpecification` in the page's structured
data, where the site has it
([Google's guidance](https://developers.google.com/structured-data/local-businesses/)).
`LocalBusiness` markup is on about 1.46 million hosts in the 2024 Web Data Commons
crawl ([stats](https://webdatacommons.org/structureddata/2024-12/stats/schema_org_subsets.html)),
but there is no figure for how many small NYC venues publish hours this way, and many
of them put hours in an image or only on Instagram. Coverage is the unknown.

**Obligations.** Opening hours are facts, and US law gives no copyright in facts and
has no separate database right (*Feist v. Rural*; cited from memory, the source page
could not be opened). Fetching public pages is generally lawful, though a site's terms
can still be a contract question
([overview of *hiQ v. LinkedIn*](https://www.fbm.com/technology/publications/what-recent-rulings-in-hiq-v-linkedin-and-other-cases-say-about-the-legality-of-data-scraping/)).
Our rules if we do this:

- obey `robots.txt`; skip the site if it disallows us;
- one request per site per week at most, only the page already on file, no crawling;
- an identifying User-Agent with a contact address;
- store the hours, the page URL and the fetch time, nothing else from the page;
- link back to the venue's site wherever we show the hours.

**Risks.** Stale markup; chains whose markup describes head office; markup that
disagrees with the visible page.

### NYC Open Data

Checked dataset by dataset. For ordinary shops, bars and restaurants there are **no
hours**.

| Dataset | Hours? | Use |
|---|---|---|
| Privately owned public spaces (`rvih-nhyn`) | Yes, required hours of access | Hours for ~390 plazas and atriums |
| Farmers markets (`8vwk-6iz2`) | Yes, free text, about 40% blank | Hours for markets |
| Restaurant inspections (`43nn-pn8j`) | No | Still operating? Updated daily |
| DCWP licences (`w7w3-xahh`) | No | Licence status and expiry |
| State liquor licences (`9s3h-dpkz`, data.ny.gov) | No | Licence expiry |
| Open Restaurants (`pitm-atqc`) | No | Historic; little |

Library, parks and museum hours were not confirmed. The city's open-data law bars
use restrictions on public datasets but allows attribution; the portal's terms page
could not be opened, so check it before use.

**Verdict.** Useful later as a closure signal, which Larper also lacks. Not an hours
source.

### AllThePlaces

Scrapes brand store locators: 20M+ places from 4,100+ spiders, weekly, data CC0
([site](https://www.alltheplaces.xyz/)). It carries hours in a simplified OSM syntax
([format](https://raw.githubusercontent.com/alltheplaces/alltheplaces/master/DATA_FORMAT.md)),
and Overture already includes 1.9 million of its places. But it is chains only, its
ids aren't stable, and the data is itself scraped from brand sites. Larper sends
people to independents. **Skip.**

### Also checked

Foursquare's open places dataset (Apache 2.0) has no hours; it has `date_closed`,
which could help with closures
([schema](https://docs.foursquare.com/data-products/docs/places-os-data-schema)).

## What this means for the data model

Every hours fact records its **source**, **source URL**, **fetch time** and a
**confidence**, so that:

- a source can be withdrawn in one statement if its licence turns out not to fit;
- the place card can show where the hours came from, which is also how the
  attribution duty is met;
- a second source disagreeing with the first is visible rather than overwritten.

If OpenStreetMap is ever approved, its rows stay in a table of their own.

## Decisions for the owner

1. Approve sources 1 to 3 above (check-ins, hand verification, venue websites under
   the listed rules)?
2. OpenStreetMap: leave it out, or take the publish-under-ODbL route once the open
   question is answered?
3. Who answers the open questions.

## Open questions on OpenStreetMap

1. Is an OSM hours table joined by name and location to Overture places a collective
   database or a derivative one?
2. Does the match itself (an OSM id beside an Overture id) create a derivative?
3. Does mixing OSM hours with other hours for the same places break the
   "all OSM or all non-OSM" test?
4. Is a place card showing OSM-derived hours a produced work, or public use of the
   database?
5. If share-alike applies, what exactly must be offered, and does publishing the hours
   table in the repository satisfy it?
6. Are a few hundred systematically chosen places "substantial"?
7. The map (OSM tiles) and the place cards both show restaurants. Does that matter
   under the horizontal-layers guideline?

## Not verified

*Feist* (cited from memory); the NYC Open Data terms page; the Manhattan hours share
(indicative); counts for the three neighborhoods; whether Squarespace, Wix, Toast or
BentoBox emit hours markup; hours in library, parks and museum datasets.
