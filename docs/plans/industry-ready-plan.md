# Larper: industry-ready plan

Written 2026-11-16. Assesses Larper as it will be once the Larper OS redesign
(#84 → #85 → #86 → #87) merges, reading the `web/larper-os-quest-screen` branch for
the web app and `origin/main` (bb2e1a9) for the API, workers, database and infra.

Constraints taken as fixed: solo developer (student, job hunting), $0 API fees for
now, NYC only, the Larper OS redesign is final.

Goal: **30 geo-verified check-ins from 15+ people who aren't the owner.**

## The short version

Larper's engineering is ahead of its product. The infrastructure (roles, backups with a
tested restore, rate limits, CI, cookieless analytics) is better than most student
projects and many seed-stage startups. The product has never been used by anyone who
isn't the owner or the shared demo account, and the one thing it does, send you to a
place, can't yet promise the place is open, real, or any good.

Nothing on the current roadmap (M9 profile stats, archetypes, share cards) moves the
goal. Stop building identity features for users who don't exist. Spend the next twelve
weeks making one quest trustworthy in three neighborhoods and getting fifteen people
to walk to one.

## The 3 things that matter most

1. **A quest must never waste a walk.** The scoring rewards "rare tag nearby"
   (`scoring.ts:66-76`), which can't tell a niche gem from an obscure, closed or
   irrelevant listing. There are no opening hours anywhere in the schema, no category
   exclusions at query time, and no duplicate handling beyond `overture_id`. One bad
   walk ends the relationship, and with 15 target users each loss is 7% of the goal.
   Fix: the hard eligibility gate, hand-verified places in three neighborhoods, and
   "Was it open? Worth it?" at check-in feeding back into eligibility.

   Be clear about what the gate (#90) buys. Measured on the current data it removes
   about 10% of places by confidence, 0.3% by category and 0.3% as duplicates. It
   stops the embarrassing cases. It does not make a quest good or tell you a place is
   open. Verification and check-in feedback do that, and they are the real work.

2. **Real people have to be able to get in, and have a reason to come back.** Clerk
   sign-up is Restricted, the public path is one shared demo account whose check-ins
   are simulated, and nothing ever contacts a user again. The goal needs real accounts
   and one re-engagement channel. Accept-means-save gives returning a purpose ("your
   list"), and a weekly email gives it a trigger.

3. **The journal is location history, and there is no way to delete it.** No account
   deletion, no export, no Terms, no retention statement, and `quests.origin` keeps
   the exact position of every offer indefinitely (audit item 6, still open). This is
   the only area where inviting 15 real people creates real liability. It is about
   two PRs of work and must land before recruiting anyone.

Everything else is either already good enough or doesn't matter until these three are
done.

## Assessment by area

Ratings: **missing** (not there), **weak** (there, not good enough for strangers),
**solid** (good enough for this stage).

| Area | Rating | Evidence |
|---|---|---|
| Recommendation quality and trust | **weak** | Scoring is principled: `(0.7·fit + 0.3·rarity) · indie · confidence · distance decay`, then MMR for variety. But rarity is "rarest tag in the area", not quality. Confidence only scales the score by 0.875–1.0, because ingest already drops everything under 0.5. No hours, no category blocklist at query time, no near-duplicate handling. Closure handling is a name heuristic at ingest plus a 3-day re-offer delay when a user says "closed". Nothing learns that a place was bad. |
| First-run experience | **weak** | The redesign is coherent and the quest screen has loading, empty, error and location states. But a new person can't sign up (Restricted), the demo's check-ins are simulated, and onboarding ends at one quest with nine leads behind a sheet. Show three leads first. |
| Retention and re-engagement | **missing** | No email, push or reminder of any kind. One quest a day and a journal, with nothing to come back for between quests. No saved list. |
| Data quality and coverage | **weak** | 80,001 of 566k open NYC places loaded, all Overture, all confidence ≥ 0.5. Hours: none. Closures: ingest-time `operating_status` plus `location_suspect`; no refresh schedule (audit item 8). Duplicates: only exact `overture_id`. Confidence, measured this session on the local extract: it clusters at 0.55, 0.65, 0.75, 0.77, 0.92 and 0.99; 9.7% of loaded places sit under 0.7. |
| Trust and safety | **weak** | No category exclusions: a clinic, a school or a place of worship can be a quest if it fires a taste tag. No way to report a place. Geofenced check-in (75 m + accuracy bonus, max 125 m) is sound and attempts are logged without coordinates. |
| Privacy and legal | **missing** | `/privacy` exists and is honest about analytics, but says nothing on retention, deletion, export or contact. No deletion or export endpoint. No Terms. No credits page. Map attribution relies on whatever OpenFreeMap's TileJSON supplies and hasn't been checked at runtime in the new dock layout. `data/nyc.parquet` (Overture data) is committed with no license notice beside it. |
| Accessibility | **solid, with gaps** | The sheet has keyboard snaps, Escape with focus recovery, `aria-expanded`, live announcements, 44 px minimums in the new CSS and a reduced-motion path. See the #87 review notes in the session report for the remaining items. |
| Performance | **weak, and unmeasured in the repo** | The 6.33 s throttled baseline is not written down anywhere in the repo. #87's description reports a 3.33 s median first card on a different method (mocked auth, local). API latency is excellent (p95 47 ms at 195 req/s). There is no web-vitals collection and no committed method, so nobody can say whether it got better. |
| Reliability and ops | **solid for one VM** | Continuous WAL + weekly base backup to Object Storage, restore drilled on the real VM on 2026-10-21 (77 s, checksums matched), hourly dead-man's switch, hard quota caps and a $1 budget alarm. Gaps: no external uptime check documented, the first scheduled weekly base backup is unverified, Oracle can reclaim an idle Always Free VM, alerts are email only. |
| Security | **solid** | Per-service database roles with no DELETE for the API, exact-origin CORS, layered rate limits, gitleaks on full history, Sentry scrubbing, key-only SSH. Gaps: no security headers on the API, Dependabot covers only the Postgres image. |
| Analytics | **solid design, wrong tool for the goal** | PostHog is cookieless with no person profiles, explicit events, category + distance bucket only. That is right and should stay. But it means PostHog cannot count distinct people or retention. The goal metric must come from Postgres, which already has `user_id`, `completed_at` and the simulated flag. No place needs to be tracked to measure anything in this plan. |
| Growth and sharing | **missing** | Nothing to share and no way to invite. This is fine for now; see "what to cut". |
| Engineering quality | **solid** | Ten CI jobs including migrations up/down/up and role-grant tests, ~527 JS tests and 55 Go tests, ADRs, an audit with tracked findings. Weak spots: CI installs PostGIS from apt into pinned images, which broke every branch on 2026-11-16 when the package moved ahead (#88, #89); README is stale (no Vercel, Sentry, PostHog; status stops at M8), `AGENTS.md` is untracked, two M9-plan commits sit unpushed on `feat/m9-quest-facts`. |

## Adopted context, and where the code disagrees

- **Measure retention weekly.** Adopted. One quest a day makes daily retention noise.
- **The quest can't tell niche from obscure and bad.** Confirmed in `scoring.ts`.
- **Accept should mean save.** Not built. No saved-place table exists. Part of the
  trust-gate PR.
- **"Not today" must not count as dislike.** Already true, with one exception to
  decide. `not-today` emits a `NOT_TODAY` event and the taste worker ignores it
  (`taste.go` has no step for it). Reasons `too_far`, `closed`, `not_today` and no
  reason at all also move nothing. The exception: the reason **"not my thing"**
  re-emits as `SKIPPED` and applies the −0.05 taste penalty (`giveReason`). That is
  an explicit statement of dislike, so I'd keep it. It is the owner's call.
- **Hard eligibility gate.** Not built. The trust-gate PR.
- **"Was it open? Worth it?" at check-in.** Not built. Week 2.
- **9 leads, show 3 first.** The API returns up to 9; the sheet shows all. Week 2, web only.
- **One re-engagement channel.** None exists. Recommendation below: one weekly email.
- **Cut Tonight and the seasonal recap.** Neither appears anywhere in the repo, so
  there is nothing to remove, only something not to start.
- **Three neighborhoods near NYU.** The app has no notion of neighborhoods at all
  today. Weeks 3–4.

**The hours rule has a consequence nobody has faced yet.** "Never offer a place with
unknown hours after 6pm" is the right rule. But every place has unknown hours, so
switched on today it means no quests after 6pm for anyone, which is when students are
free. The rule ships behind a setting that is off until hours exist for the focus
neighborhoods. Getting those hours is therefore on the critical path, not a nice-to-have.

## 12-week roadmap

Ordered by value, then effort, then what unblocks what. Cost marks: **$0**,
**manual** (ongoing owner time), **later $** (free now, costs money at scale).

| Weeks | Item | Why now | Cost |
|---|---|---|---|
| 1 | Fix CI (#88, #89), then merge the redesign stack; close #80 | Everything else builds on it | $0 |
| 1 | Trust gate (#90): confidence floor, category blocklist, dedupe, hours rule (off), Accept saves | Thing 1 | $0 |
| 1–2 | Account deletion + export, retention limits, Terms, privacy update, credits page | Thing 3; blocks recruiting | $0 |
| 2 | "Was it open? Worth it?" at check-in, stored per place | The only quality signal available for free | $0 |
| 2 | Show 3 leads first; "want to go" list in the journal | Makes Accept mean something | $0 |
| 3 | Focus area: East Village, Union Square, Greenwich Village as polygons; hand-verified places with hours in a `place_facts` table; verified places rank first | Thing 1; turns the hours rule on | **manual**: ~150 places once, ~1 h/week after |
| 3 | Weekly metrics script (SQL, read-only) and a written perf method with a committed baseline | Can't steer without it | $0 |
| 4 | Open sign-up behind an invite code; weekly email, opt-in | Thing 2 | **later $** (email free tier) |
| 4–6 | Recruit: 25 invited to get 15 active. In person, NYU, one neighborhood at a time | The goal | **manual** |
| 5–6 | Feedback loop: two "wasn't open" reports suspend a place pending re-verification; "report this place" link | Keeps the verified set true | **manual** review |
| 7–8 | Fix what the first 15 people hit. Reserve these weeks; don't pre-plan them | Real usage beats any plan | $0 |
| 9–10 | Hours from OpenStreetMap for the focus area, in a separate table with its own attribution | Extends evening coverage beyond hand-verified places | $0, license care |
| 11 | External uptime check; verify a scheduled base backup; security headers | Cheap reliability | $0 |
| 12 | Decide: expand neighborhoods, or pay for hours data. Write up results | See evidence below | — |

**What would justify paying**

- *A places API for hours* (the first thing worth money): if, after week 8, more than
  10% of check-ins answer "wasn't open", or evening quests can't be filled from
  verified places for more than a third of evening sessions.
- *A bigger VM or managed Postgres*: not on usage this plan can generate. Only if
  Oracle reclaims the VM twice.
- *Email beyond the free tier*: at ~3,000 emails a month, which is ~700 weekly
  subscribers. A good problem.

## The next 4 weeks as PRs

Week 1
0. **CI fix** #88 and #89, first: two jobs are red on every branch until they merge.
1. **Redesign stack** #84, #85, #86, #87 (merge plan in the session report).
2. **Trust gate** #90 (`apps/api`, migration 0017): eligibility module, saved places
   on Accept, tests proving Not today never moves taste. Open.
3. **Delete and export my data** (`apps/api`, migration): `DELETE /me` through a
   SECURITY DEFINER function so the API role still has no DELETE grant; Clerk user
   removal as a proposed live change; `GET /me/export` as JSON. Null out
   `quests.origin` after the offer expires.
4. **Privacy, Terms, credits** (`apps/web`): retention and deletion on `/privacy`,
   a short `/terms`, a `/credits` page for Overture, OpenStreetMap, OpenFreeMap; a
   license notice beside `data/nyc.parquet`.

Week 2
5. **Check-in feedback** (`apps/api`, migration; `apps/web`): two optional taps after
   the stamp. Stored against the place with the user id, never sent to analytics
   beyond `was_open: bool` and `worth_it: bool`.
6. **Three leads first** (`apps/web`): show 3, "more leads" reveals the rest.
7. **Want-to-go list** (`apps/api` read endpoint from PR 2; `apps/web` journal tab).

Week 3
8. **Focus neighborhoods + place facts** (`apps/api`, migration, a loader script):
   three polygons, a `place_facts` table (verified_at, hours, note), verified places
   outrank unverified inside the polygons; switch the after-6pm rule on.
9. **Weekly metrics** (`scripts/`, read-only SQL) and **perf baseline doc** (`docs/`).

Week 4
10. **Invite-code sign-up** (`apps/web`, Clerk setting change proposed separately).
11. **Weekly email** (`apps/api` or a worker; one provider; opt-in; one-click
    unsubscribe): "3 places on your list and near you this week".

PRs 3, 4, 10 and 11 touch auth, security or the web app, so they all wait for the
owner to merge.

## What to cut

- **M9 phases 2–5** (profile stats consumer, archetypes, k-means, share cards,
  percentile). Phase 1 is merged and harmless. The rest is weeks of work to describe
  the taste of users who haven't arrived. Park it; the plan document keeps.
- **Tonight and the seasonal recap.** Don't start.
- **Any more cloud demos** (EKS, AKS) and load tests. 195 req/s with zero errors is
  already more capacity than this plan can use by three orders of magnitude.
- **Sharing and growth features.** Fifteen people come from asking them in person.
- **Push notifications and a PWA.** One channel means one.
- **Citywide coverage as a promise.** Outside the focus area the app should say
  "Larper is best around Union Square right now" rather than offer unverified quests
  as confidently as verified ones.
- **Daily streaks.** They contradict "measure weekly" and punish the behaviour you
  want (going once, properly).

## Metrics

All from Postgres, counting users, never places. Exclude the owner's user id, the demo
account and simulated check-ins.

**North star (weekly):** geo-verified check-ins by people who aren't the owner.
Target: 30 cumulative from 15+ distinct people by week 12.

**Guardrails**

1. **Wasted walks:** share of check-ins answering "wasn't open". Under 10%; over 20%
   stops recruiting until fixed.
2. **Weekly return:** of people who checked in or accepted in week N, the share who do
   either in week N+1. Watch the trend; with 15 people, don't quote a percentage.
3. **Accept → check-in within 7 days.** If saving is all people do, the quest isn't
   compelling enough to walk to.
4. **Time to first quest card**, p75, by the committed method. No regressions past
   the baseline.
5. **Cost and uptime:** $0 spend; the dead-man's switch and uptime check quiet.

## Risks and open decisions

| | Risk or decision | Recommendation |
|---|---|---|
| R1 | Oracle reclaims the Always Free VM mid-pilot | Accept. The rebuild is documented at ~30 min and backups are tested. Add an uptime check so you hear about it. |
| R2 | Hand-verifying places doesn't scale | It doesn't need to. 150 places serve 15 people. It's also the best user research available: walk the neighborhoods. |
| R3 | 15 people is too few for any statistics | Correct. Treat every number as a count, talk to each person, and don't A/B test anything. |
| R4 | OpenStreetMap hours bring ODbL share-alike questions if merged into the places table | Keep OSM-derived data in its own table with its own attribution, and read the licence before week 9. This plan is not legal advice. |
| R5 | Job hunt takes the time | The roadmap's first four weeks are the story. Weeks 5–12 are mostly manual and flexible. |
| D1 | Does "not my thing" after Not today count as a dislike? | Yes, keep it. It's the user saying so in words. |
| D2 | Open sign-up, or invite codes? | Invite codes. Keeps the pilot small and the data clean. |
| D3 | Re-engagement channel | One weekly email. Push on iOS needs an installed PWA; SMS costs money. |
| D4 | Turn on the after-6pm rule before hours exist? | No. Ship it off; turn it on with PR 8. |
| D5 | Keep the shared demo account once real sign-up exists? | Keep it for recruiters, exclude it from every metric (already the case). |
| D6 | What happens to the two unpushed M9-plan commits? | Push them as a docs PR or drop them; they shouldn't live only on a laptop. |
| D7 | Is deleting a Clerk user from the API acceptable? | It's a live-system write and puts a second use of the Clerk secret in the cluster. Alternative: delete Larper's data immediately, and the owner removes the Clerk user by hand weekly. Start with the alternative. |

## The recruiter story

What's true today:

> I built a location-based discovery app end to end: a ranking service over 80,000
> NYC places with vector taste profiles, an event pipeline, and a single $0/month VM
> with tested backup restores, per-service database roles and privacy-preserving
> analytics. It handles 195 requests a second at a 47 ms p95.

That is an infrastructure story about a product nobody uses. Every interviewer's next
question is "who uses it?", and today the answer is "me".

What it should be in twelve weeks:

> I cut the roadmap to one goal, real people walking to a place the app chose, and
> got there: N check-ins verified by GPS from M people in three neighborhoods. The
> hard part wasn't ranking, it was trust: X% of early quests were closed or wrong, so
> I added an eligibility gate, verified places by hand, and asked "was it open?" at
> every check-in, which brought wasted walks down to Y%. I did it for $0 and without
> tracking where anyone went.

Numbers needed, all from the weekly metrics script:

- check-ins verified by GPS, and distinct people (target 30 and 15);
- wasted-walk rate before and after the gate;
- weekly return count ("9 of 15 came back a second week");
- accept → check-in rate;
- time to first quest card, before and after, by one written method;
- monthly cost ($0) and restore time (77 s, already measured).

The first paragraph gets an interview for infrastructure roles. The second gets one
anywhere, because it shows judgment about what not to build.
