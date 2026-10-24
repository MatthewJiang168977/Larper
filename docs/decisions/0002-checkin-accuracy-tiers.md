# 0002: Accept rough check-ins as "unverified" at reduced weight (deferred)

- **Status:** deferred, 2026-10-18. Revisit once the `checkin` log has a few weeks of real
  attempts.
- **Scope:** the check-in geofence (`apps/api/src/quests/checkin.ts`), the quest event
  (`proto/`), the taste-worker's weights (`workers/internal/taste`), a `quests` migration
- **Related:** audit 2026-10, item 1; the fix that shipped instead (below)

## Context

Check-in ("I went") is the end of the core loop and the strongest taste signal (+0.20). The
API accepts it when the reported position is within **75 m + min(accuracy, 50 m)** of the
place, so 75 m with no accuracy and 125 m at most. Every position is reported by the client,
so no rule here stops a modified client. The goal is fairness for honest users, not
anti-cheat.

Two problems with that rule alone:

- **False rejects indoors.** Phones indoors usually locate by Wi-Fi to tens of metres, but in
  basements and between tall buildings a fix can drift to ±100–300 m. Someone at the bar
  with a ±300 m fix centred 200 m away is told "You're 200 m away", though they may be
  standing at the door.
- **Nothing said about rough fixes.** A ±2 km fix (approximate location on iOS, cell or IP
  positioning) whose centre happens to land within 125 m passes. One that lands further
  away gets a distance that means nothing.

## What shipped instead (the smaller step)

- **A fresh reading on "I went".** The web app takes one fresh, high-accuracy reading
  (`enableHighAccuracy`, no cached readings), keeps the best for up to 8 s, and shows
  "Getting a precise fix…" meanwhile. Before, it sent the map's position, which could be
  30 s old and was only updated after a 40 m move.
- **Clearer rejections, with Try again.** Same acceptance rule, two messages:
  - **`too_far`:** the fix's own uncertainty circle doesn't reach the place's 75 m radius
    (*distance − accuracy > 75*), so the user is confidently elsewhere. The message gives
    the distance: "You're 312 m away."
  - **`too_rough`:** the circle does reach it, so the fix can't tell. "Your location is too
    rough to tell (±813 m). Turn on precise location or step outside, then try again."
  - Both get a Try again that takes a new reading.
- **A log line per attempt.** Every check-in attempt logs
  `checkin {"questId","outcome","distanceM","accuracyM","allowedM"}`, with outcome
  `accepted | too_far | too_rough | no_position | not_found | conflict | error`. It holds no
  coordinates (the distance to the place is all the rule uses) and no user id. The quest id
  ties a Try again to its first attempt.

This fixes stale and coarse positions and says what's wrong. It still rejects an honest user
whose phone genuinely can't do better than ±300 m indoors.

## The deferred option: three tiers

Let *d* be the distance to the place and *a* the reported accuracy.

| Tier | When | Effect |
|---|---|---|
| Verified | *d* ≤ 75 + min(*a*, 50) | Today's rule. Full taste signal (+0.20). |
| Unverified | Fails that, but *d* ≤ 75 + min(*a*, 500): the fix's circle reaches the place | The quest completes, marked unverified. Half weight (+0.10). The user sees "Checked in. Your location was rough (±*a* m), so this one counts a little less." |
| Rejected | Beyond even that | As shipped: "too far" when *a* ≤ 100 and the fix is confident, "too rough" with Try again when *a* > 500 |

### What it needs

- **Event:** the quest event (protobuf) gets a `verified` field. The taste-worker gives the
  check-in a weight per tier.
- **Migration:** a `quests` migration records the check-in's accuracy and distance, or at
  least the tier, so the journal can show it and the data can be audited later.
- **Web:** the confirmation copy for an unverified check-in.

### Tradeoffs

- **For:** legitimate indoor check-ins with a rough but honest fix stop being rejected. They
  count, just less.
- **Against:** a rough fix (±500 m) whose centre lands up to ~575 m away completes the quest.
  That covers honest-but-imprecise users and a little gaming, both bounded by the half
  weight and the flag. It also touches four parts of the system (API, proto, worker,
  migration) for a problem we haven't measured yet.
- **Strict cutoff instead** (reject anything rougher than ±100 m): simpler, and it never
  completes a quest on a bad fix. But users with approximate location on, whose accuracy is
  in kilometres, and people in basements could never check in. Rejected for that reason.

## When to revisit

**Update 2026-10-24:** the log lines turned out to be no basis: logs go with the pod, so
every redeploy (the VM resize that day included) wiped them. Attempts are now stored in
`checkin_attempts` (migration 0014, kept 90 days, demo account flagged and left out of
the figures). Run the report as the database owner:

```
DATABASE_URL=<owner URL> node dist/ops/checkin-report.js [--days N]
```

Real volume will be low, since demo visitors are mostly far from NYC, so the report
leads with the sample size and flags a small one. **Decide on the tiers around
2026-11-14, or after a few dozen real check-ins, whichever comes first.**

With that data, look at:

- **How often rough fixes happen:** the share of attempts with `accuracyM` > 100, and how
  many of them end `too_rough`.
- **Whether Try again recovers them:** a `too_rough` followed by an `accepted` for the same
  quest.
- **Where real accepted check-ins land:** the distribution of `distanceM` on `accepted`, to
  see whether 75 m is the right radius at all.

If `too_rough` is rare, or Try again usually recovers it, the shipped step is enough and this
stays deferred. If it's common and doesn't recover, build the tiers, with thresholds taken
from those numbers instead of the 100 / 500 m above.
