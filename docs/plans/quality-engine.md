# Product quality engine

Written 2026-11-26. Covers items 1-4 (curation, reliability, "worth it?", measuring pick
quality) and how item 5 (hours-aware picking) uses them.

## The problem

Larper collects feedback but doesn't learn from it:

- "Was it open?" is stored in `place_hours_facts` (`was_open`), and ranking never reads it.
- Of the skip reasons only "not my thing" moves anything (taste). `closed` means a 3-day re-offer delay.
- Nothing measures whether a pick was good.

## The loop

```
 curation page ──► place_facts ──────────────┬──► eligibility (verdicts, hours, note)
       │                                     │
       └────────┐                            └──► golden set CSV ──► offline eval (CI)
 check-in ──────┤  PlaceReport on user.events
 skip "closed" ─┤  (transactional outbox) ──► reliability-worker ──► place_reliability
 "was it open?" ┘                                                          │
                                                           eligibility ◄───┘  (demote / exclude)
 "worth it?" ──► quests.worth_it ──► QuestEvent ──► taste-worker
                       └──► funnel report (offered → accepted → checked in → worth it)
```

## Rules that apply to everything here

- Every fact carries its source and date. Nothing is invented: no row means unknown.
- Unverified is never shown as closed.
- No OpenStreetMap data. The hours *syntax* is OSM's (as in the hours pilot); the values are
  typed by a person from the door or the venue's own site.
- Merge order is the migration order: 0023 (curation), 0024 (reliability), 0025 (worth it).
  M9's placeholder numbers move to 0026-0028.
- Each migration is applied before the API and worker pods that need it.

## 1. Curation

### Who

`ADMIN_USER_IDS`: a comma-separated list. Each entry is a Larper user id (digits, as in the
data export's `account.id`) or a Clerk user id (`user_...`). Unset: no admins. The demo
account is never an admin. Every `/admin/*` route answers **404** to anyone else, signed out
included, with the same body as a route that doesn't exist.

### Table (migration 0023)

`place_facts`, append-only. The API's role gets `SELECT, INSERT` and nothing else.

| Column | Meaning |
|---|---|
| `id` | identity |
| `place_id` | → `places`, cascade |
| `kind` | `great`, `verified`, `closed`, `bad_fit`, `hours`, `note` |
| `source` | always `hand-verified` (CHECK) |
| `user_id` | who; `NULL` once that account is deleted |
| `created_at` | when |
| `note` | `kind = 'note'`: one line, at most 140 characters; `NULL` clears the note |
| `hours_raw` | `kind = 'hours'`: the text as typed |
| `schedule` | `kind = 'hours'`: the normalized v1 schedule (`hours/schedule.ts`) |

Two groups of facts, each read as "the latest wins":

- **Verdict** (`great`, `verified`, `closed`, `bad_fit`): a later tap corrects an earlier one.
- **Hours** and **note**: the latest row of the kind. An empty value clears it.

`great` is "verified, and I'd send a friend". It is not in the original list of actions, but
the golden set needs `great` as separate from `fine`, and only the curator can say which.

### Hours

The same text as the hours-pilot CSV's `opening_hours`. The API parses a **strict subset**
of what the Go importer accepts: weekday lists and ranges, one or more time spans, `off` /
`closed`, `24/7`, `PH off`, and single dates (`Dec 25 off`). Anything else is refused with
a message; nothing is stored half-understood. A shared vector file
(`hours/testdata/parse-vectors.json`) is checked by both the Go and the TypeScript tests,
so every input the API accepts means the same thing to the importer.

A shared vector file proves agreement only for the inputs it lists, so the TypeScript
parser errs towards refusing (including a weekday rule written after a date or `PH` rule).

**How the hours are read.** The existing hours reader (`hours/place-hours.ts`) takes the
latest hand-verified hours of a place from `place_facts` as one more `regular` schedule
fact, with the same confidence (0.9) as the pilot importer's `manual` rows, so between the
two the newer one wins. Clearing the hours also masks older `manual` rows: the place reads
as unverified. Kitchen and bar hours stay the importer's.

Hand-verified hours **expire after 90 days**: an older schedule is not used, and the place
reads as unverified. This applies to `hand-verified` and to `manual` rows, which are the
same person looking.

### Effect on offering

- A latest verdict of `closed` or `bad_fit`: not offered, as quest or lead. Applied after
  the deck cache, so a tap takes effect on the next request.
- A note: the quest response carries it with its date; "Why this place" shows it first.
- A quest the user already has is never revoked.

### The page

`/admin/places` in `apps/web`, in no navigation. One neighbourhood at a time (the polygons
of `data/focus-neighborhoods.geojson`, copied into the API's source because its image holds
only `apps/api`; a test keeps the two equal), places sorted by how likely they are to be offered:
the quest score without personal taste or distance (rarity x not-a-chain x confidence),
over the places that pass the static gate. Each card: name, category, website and Instagram
links, a map link, current hours facts, recent reports (read from the check-in answers and
skip reasons: day and kind, no user ids), verdict and note. The reports are an exception to
the three-people floor on public confirmations: only the operator, who can read the
database anyway, sees them. Keyboard: `j`/`k` next and previous, `g` great, `v` verified, `c` closed,
`b` bad fit, `h` hours, `n` note. A verdict moves to the next place.
With reliability (item 2) the page also shows each place's score and has a "suspended"
list across all areas, so a suspended place anywhere can be found and re-verified.

The `places` table stores **no street address**, so the card says so and links to a map at
the place's coordinates. Storing addresses needs an ingest change and a reload: not here.

## 2. Reliability

### Event

`larper.events.v1.PlaceReport`, on `user.events` through the outbox, written in the same
transaction as the fact it describes. Key: the reporting user's id (so "delete my history"
removes unsent ones, like quest events); curation events are keyed `place:<id>`, so the
curator clearing their own history never drops a hand verdict. `taste-worker` ignores the
type.

| Field | |
|---|---|
| `event_id` | UUID, the dedupe key |
| `user_id` | who |
| `place_id` | |
| `quest_id` | empty for curation |
| `kind` | `CHECKED_IN`, `CONFIRMED_OPEN`, `WASNT_OPEN`, `SKIPPED_CLOSED`, `HAND_VERIFIED`, `HAND_CLOSED` |
| `occurred_at` | |

The demo account and simulated check-ins emit nothing, and neither does "didn't check" or a
repeated "was it open?".

### Tables (migration 0024)

- `place_reports(event_id PK, place_id, user_id, quest_id, kind, occurred_at)`: the
  evidence. It is in the data export, and `delete_my_history` (replaced by this migration)
  removes the user's rows, except hand verdicts, which are facts about the place and stay
  with the user id cleared.
- `place_reliability(place_id PK, successes, failures, as_of, suspended_at, stale,
  updated_at)`: the result.

The migration backfills `place_reports` from existing check-in answers and curation
verdicts, and marks those places `stale`. Past `closed` skips are not backfilled: SQL cannot
tell the shared demo account's from a person's, and the demo account must report nothing.

**How the worker stays correct:**

- *Deleted users.* Like `taste-worker`, it takes the user (and quest) lock before inserting
  (`lock_user_quest`, or the user alone for curation). An event whose user or quest is gone
  is recorded as processed and adds no evidence.
- *Concurrency.* Reports about one place can arrive on different partitions, so it takes a
  per-place advisory lock before reading the evidence.
- *Replays.* `processed_events` makes a redelivery a no-op. The score is a function of the
  set of reports, so order doesn't matter.
- *History deletion.* `delete_my_history` marks the places it touched `stale`; the worker
  recomputes stale rows once a minute. A suspension is **sticky**: neither deletion nor
  decay lifts it, only a hand verification made after it.

A new login role, `larper_reliability`, for the new `reliability-worker`
(docs/decisions/0003). The API reads `place_reliability`, and `place_reports` for the
export. The chart's connection budget must be rebalanced (the demo profile is exactly full).

### The estimate

"Probability the place is open and as described", Beta-Bernoulli:

```
score = (a0 + S) / (a0 + S + b0 + F)        prior a0 = 4, b0 = 1  (mean 0.80)
```

`S` and `F` are weighted reports, each decayed by `0.5 ^ (age / half-life)`.

**Half-life: 60 days.** Places change over months, and verified hours expire at 90 days;
at 60 days a report still counts half after two months and an eighth after six.

| Report | Counts as | Weight |
|---|---|---|
| Hand-verified (`great`, `verified`) | success | 1.5, and it discards older reports |
| Hand-closed | failure | 10 |
| "Was it open?" yes | success | 1 |
| Wasn't open | failure | 1 |
| Skipped, reason "closed" | failure | 0.75 (they may not have gone) |
| Check-in, no answer | success | 0.5 |

A **visit** is one quest. One person counts **once per place**: only their latest visit
there. Within a visit a failure beats a success, and "yes" beats "no answer". Hand verdicts
are outside both rules: they are not visits.

### What eligibility does with it

- **Demoted:** below the prior mean, the ranking score is multiplied by `score / 0.8`.
- **Excluded:** a place is suspended when, since its last hand verification, any of:
  - **two different people** answered "wasn't open", within 60 days of each other (the rule
    in the industry-ready plan, whatever the earlier successes);
  - the score at the time of a report falls below **0.6** (mixtures of weaker evidence);
  - the curator marked it closed.
- A suspension lasts until a later hand verification.
- One report never suspends: one "wasn't open" on a place with no other evidence scores 0.67.
- Demotion and exclusion apply after the 10-minute deck cache, as verdicts do.

Metric: `places_excluded_by_reliability` (gauge, from the API; take the max across pods).

## 3. "Worth it?"

Migration 0025: `quests.worth_it` (`yes`, `meh`, `no`) and `worth_it_at`. A column on the
quest, so history and account deletion already remove it; the export adds it to the
journal. `POST /quests/:id/worth-it`, checked-in quests only, never simulated or demo,
first answer stands.

New `QuestAction` values on the existing `QuestEvent`: `WORTH_IT_YES`, `WORTH_IT_MEH`,
`WORTH_IT_NO`. Old taste-workers ignore unknown values and commit past them, so an answer
given during a rollout may not move taste (it is still stored). Writing `worth_it` does not
touch `updated_at`, which drives re-offering and "done today".

| Signal | Taste step |
|---|---|
| accept | +0.10 |
| check-in | +0.20 |
| skip ("not my thing") | -0.05 |
| **worth it: yes** | **+0.25** |
| **worth it: meh** | **-0.15** |
| **worth it: no** | **-0.20** |

In the web app the question sits under "was it open?", optional, with a skip. It is not
asked after "no" to "was it open?".

## 4. Measuring pick quality

### Golden set

`data/golden-places.csv`: `overture_id,rating,note,rated_at`, starting with only the header.
`ops/golden-export` writes it from the latest verdict per place (read-only):
`great` → `great`, `verified` → `fine`, `bad_fit` → `bad`, `closed` → `closed`. `rated_at`
is a date without a time, so the public file doesn't record when the curator was where.

**The repository is public**, so insider notes are exported only with `--notes`.

### Offline eval

The ranker's pure steps (static gate, score, MMR) are shared between the service and the
eval. For 20 synthetic taste profiles at fixed points in the three neighbourhoods it
reports top-1 and top-3 "great" hit rate and the rate of "bad or closed" in the top 3.
Curation verdicts and reliability are **not** applied: the eval measures the ranker, and
applying the answers would make it look perfect.

It runs in two modes:

- **Real data** (by hand): `ops/eval-snapshot` writes the places of the three areas from a
  database (read-only), and the eval scores them against `data/golden-places.csv`. The
  result goes to `docs/eval/`. This is the measure of pick quality.
- **CI** (regression gate): CI has no real places, so no real rating could match.

The SQL parts of ranking (radius, candidate limit, taste similarity, area stats) are
reimplemented in memory; a database test checks that both give the same order.

CI runs it on a synthetic fixture (made-up places, labelled as such, never presented as
facts) and fails if top-1 great drops more than 0.05, or bad/closed rises more than 0.02,
against `docs/eval/baseline.json`.

### Funnel

`ops/funnel-report` (read-only): offered → accepted → checked in → worth it; wasted-walk
rate (wasn't open ÷ check-ins); weekly return (of people who accepted or checked in during
week N, the share doing either in week N+1). Excludes the owner and admin accounts
(`ADMIN_USER_IDS`, plus any given with `--exclude`), the demo account
and simulated check-ins, as the industry-ready plan's Metrics section says.

## 5. Hours-aware picking (uses 1)

Behind a flag, default off: don't offer a place whose verified hours say it will be closed
at now + estimated walking time. Unverified and unknown places are still offered, and are
never shown as closed.

**This changes a recorded product rule.** The industry-ready plan says "never offer a place
with unknown hours after 6pm" (`eligibility.ts`, rule d). The owner asked for the
generalised rule above, which replaces it: with the flag on, unverified places are offered
in the evening too.

## Not in this work

- Importing hours from any outside source.
- Street addresses.
- Reacting to `bad_fit` beyond not offering the place.
- A review queue for suspended places beyond the curation page.
