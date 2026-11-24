# Time to first quest card

How "time to first quest card" is measured, and the numbers recorded so far.

**Status of this document.** The numbers and the method below are taken from the
descriptions of PRs #67, #84 and #87. The measurement script itself (a headless-browser
run) was never committed: it was a throwaway harness, and no copy of it exists on `main`
or on `perf/p2-first-quest`. The steps below reconstruct the lab setup from those
descriptions. See [What is missing](#what-is-missing) for the gaps in reproducing the
recorded measurements.

## What is measured

The time from navigation start until the first quest card is in the DOM **and has painted**:
the card's text is present and a frame has been committed after it. On the quest screen that
is the sheet showing the place name, distance and actions (`QuestSheet` in
`apps/web/components/quest/quest-sheet.tsx`). The map is not part of it: since #67 the map
starts only after the sheet has painted (or after `MAP_WAIT_MS` = 3 s with no answer).

Reported alongside it, when useful: JS bytes transferred before the card, image bytes
transferred before the card, long tasks before the card (count, total, longest), and
whether the MapLibre chunk was fetched before the card.

## Method

- **Runs:** 7 per build, each in a **fresh browser context** (cold cache, no service worker,
  no storage). The **median** is reported, with the range (min to max) beside it, so one
  slow outlier does not move the number.
- **Build:** a production build, `next build` then `next start`, never `next dev`.
  Compare builds as a **paired lab comparison**: build the control (the parent commit) and
  the candidate fresh, and run both in the same session on the same machine, interleaved
  or back to back.
- **Device profile (the phone profile):** viewport 390 x 844, **4x CPU throttling**,
  network **1.6 Mbps down, 150 ms latency**. The browser was headless Chromium (Edge in #67).
- **Location:** geolocation permission granted with a fixed fix (a GPS fix), so no
  location prompt or fallback is in the way.
- **Fixtures, not production:** nothing talks to a live system.
  - The API is a **local fixture or mocked**: `/me` and `/quests/today` answered by
    request interception (#67 used 400 ms for `/me` and 800 ms for `/quests/today`; #84
    and #87 used a local fixture API). The answers are the shapes in
    `apps/web/lib/api.ts`; the sample data for the screen is in
    `apps/web/app/design-lab/quest-fixture-data.ts`.
  - **External traffic is blocked** (map tiles, fonts, analytics), so the network
    profile only throttles what the page itself needs.
  - **Clerk is bypassed.** Clerk's own JS and its handshake are left out: the page is
    treated as always signed in, with a development handshake bypass or a stub swapped in
    for `@clerk/nextjs` (#67 did it with a temporary `turbopack.resolveAlias`, not
    committed). The numbers therefore leave out Clerk's cost, which is the same before
    and after a change, and they are **lower than a real signed-in visit**.
- **Do not** compare a number from this method with one from a different method. #87's
  3.33 s and the 6.33 s baseline below were not measured the same way (see below).

## Numbers so far

**Baseline, method not recorded:** the lab baseline is **6.33 s** (throttled). It is recorded in
the session notes only. How many runs, whether it is a median, the range, the Clerk handling and
the API used are all unknown, so it is not "a median of 7" and cannot be compared one-to-one
with the rows below.

| What | Median of 7 | Range | Source |
|---|---|---|---|
| Landing page PR (#84): control | 3.83 s | 3.60 to 4.99 s | #84 description |
| Landing page PR (#84): candidate | **3.64 s** | 3.51 to 3.79 s | #84 description |
| Quest screen PR (#87): parent | 3.44 s | 3.41 to 3.54 s | #87 description |
| Quest screen PR (#87): candidate | 3.33 s | 3.31 to 4.84 s | #87 description |
| First quest sooner (#67), 4x CPU, mocked API (`/me` 400 ms, `/quests/today` 800 ms): before | 3.022 s | | #67 description |
| First quest sooner (#67), same: after | 2.260 s | | #67 description |

The #84 and #87 rows used the same profile (390 x 844, 4x CPU, 1.6 Mbps, 150 ms, local
fixture API, mocked auth, external requests blocked). The #67 rows used a different mocked
API and no network throttle, so they are not comparable with the others. Only compare a
candidate with a control measured in the same session.

## How to reproduce

Build and start each version locally. For a browser run, configure the offline Clerk
mock described below before building. The example uses same-origin request interception.

```sh
pnpm install --frozen-lockfile
cd apps/web
export NEXT_PUBLIC_API_URL=http://localhost:3000/api
export VERCEL_ENV=preview
pnpm exec next build
pnpm exec next start -p 3000
```

`next build` requires `NEXT_PUBLIC_API_URL` and embeds it in the client bundle. Use the
same host and port as the page for interception, or set it to your local fixture API
before building. With the example URL, intercept `/api/me` and `/api/quests/today`.
Keep `VERCEL_ENV=preview` set for build and start so the design-lab fixtures are available
in this local production build.

The sample quest is in `apps/web/app/design-lab/quest-fixture-data.ts`. The
`/design-lab/quest` route shows the quest screen from that sample, and #84's landing
fixtures live under `/design-lab/landing`.

The CI build step runs without Clerk keys. Serving the fixture routes is a separate
step. Even `/design-lab` uses the root Clerk provider and matches the Clerk proxy.
If your mock expects a publishable key, export this synthetic key in the same shell
before build and start. It comes from the
[pre-commit guard fixture](../../scripts/test/pre-commit-hook.test.sh).

```sh
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_Y2xlcmsuZXhhbXBsZS5jb20k
```

The fixture key points to `clerk.example.com`. The mock must handle both the
provider and proxy paths without a Clerk handshake. Use shell variables for the
fixture and keep live Clerk credentials and traffic out of the run.

The measurement itself, for each of 7 runs. This list is **reconstructed** from the PR
descriptions (the exact way the card was detected is not recorded), so treat step 4 as the
intent, not as the original code:

1. New browser context, viewport 390 x 844, geolocation granted at a fixed point in New York.
2. `Network.emulateNetworkConditions`: 1.6 Mbps down (200 000 bytes/s), latency 150 ms.
   `Emulation.setCPUThrottlingRate`: 4.
3. Allow the page's origin and, if separate, the loopback fixture API's origin. Serve
   `/me` and `/quests/today` from the fixture at the configured API base URL.
4. Navigate to `/`, and record the time at which the first quest card's text is in the
   DOM and a frame has painted after it (a `requestAnimationFrame` after the mutation).
5. Take the median of the 7 and write down the min and max.

Repeat for the control build, and report the pair.

## What is missing

- The original harness, including the exact card-detection code and Clerk bypass. The
  session report records that the harness was never committed. A new scripted run
  would measure the reconstructed method above.
- The setup behind the 6.33 s baseline (which Clerk handling, API and network profile).
  Treat it as a rough reference until the control and candidate are measured together.
- Any measurement against the real API or a real Clerk session; the method is
  deliberately offline so it never touches production.

## Polish PR (Larper OS transitions, toasts, PWA, OG images)

Measured with `docs/perf/first-quest-card.mjs` (raw Chrome DevTools Protocol, Edge headless:
390 x 844, 4x CPU, 1.6 Mbps, 150 ms, cache off, external requests blocked, fresh context per run) on
`/design-lab/quest` from production builds (`VERCEL_ENV=preview`, fixture Clerk key). Clerk's
handshake is bypassed with dev-session cookies (`__clerk_db_jwt`, `__client_uat=0`), so Clerk's own
JS is not in the numbers. Usage: `node docs/perf/first-quest-card.mjs <url> <runs>` against
`next start`. This script is a committed version of the reconstructed harness above.

Control = `main`, candidate = the polish branch. Four rounds of 5 runs per build, order alternated
each round (control first in rounds 1 and 3, candidate first in rounds 2 and 4):

| What | Median of 20 | Range |
|---|---|---|
| control (main) | 4.99 s | 4.18 to 7.35 s |
| candidate | 5.12 s | 4.02 to 7.08 s |

The difference (+0.13 s, +2.7%) is inside the run-to-run spread, so no regression is detectable at
this noise level. It is not proof of zero. Transferred bytes on the same page: JS +8.7 KB (+1.3%),
CSS +2.4 KB. An earlier, order-unbalanced run showed the candidate about 0.5 s slower; moving
the toast animation code out of the root bundle (loaded on the first toast) and alternating the
run order removed that gap. The absolute numbers are higher than the table above because this
machine and profile differ; only compare a control and candidate from the same session.
