# Larper session report, 2026-11-23

Each task branch started from `main` at `67da608`. The menu PR was already open
from the preceding design review. No PR was merged, no production settings were
changed, and no live deploy scripts or dashboards were used. The disposable
Postgres containers were stopped and removed. No worktrees or credential copies
were created.

## Pull requests

| PR | Head | CI | Review |
| --- | --- | --- | --- |
| [#129 Menu bar](https://github.com/MatthewJiang168977/Larper/pull/129) | `3960347` | Green | The styling from the last review. Review the matching account text and evenly spaced labels. |
| [#130 Quest sheet and pins](https://github.com/MatthewJiang168977/Larper/pull/130) | `a358b89` | Green | Review the phone placement and the pin spread on a dense map. |
| [#131 Category gate exceptions](https://github.com/MatthewJiang168977/Larper/pull/131) | `3085f66` | Green | **Approve the liquor-store and shooting-range exclusions before merging.** Confirm the three catalog exceptions. |
| [#132 Clerk production prep](https://github.com/MatthewJiang168977/Larper/pull/132) | `236d50a` | Green | Review the matched web/API cutover, identity handling, demo choice and rollback. |
| [#133 Weekly quest email](https://github.com/MatthewJiang168977/Larper/pull/133) | `98ccdc2` | Green | Review migration `0022`, consent and delivery rules, and the provider setup. Both flags default to off. |
| [#134 Public quest preview](https://github.com/MatthewJiang168977/Larper/pull/134) | `316b276` | Green | Review the three focus neighborhoods, prompts and rate-limit budget. Plan only. |

## Decisions and verification

- **Menu.** Kept the version from the preceding design review. Account
  uses the original journal typography and hover color, and retains the Clerk
  trigger for real accounts. Verified 14px gaps at 390px and 1440px.
- **Quest sheet and map.** Kept one website link and showed the dialable phone
  number beside unverified hours. Known-hours source attribution remains.
  Separated colliding pins by moving the leads to the nearest available screen
  positions while leaving the quest anchored. Leads return to their map anchors
  when zoom separates them. Chrome verified four coincident
  pins at both widths with disjoint targets of at least 44px.
- **Eligibility.** Used the checked-in catalog's stable Overture IDs for C.O.
  Bigelow Chemists, Dichter Pharmacy & Soda Shop and Bill Rainey Park. The
  exception covers category only. Both the quest query and hours pilot share
  the rule. New decks use cache version 6.
- **Clerk.** The prior release wrapper reads a Clerk secret key but does not
  select a live verifier key. The Oracle profile can read the publishable-key
  override and webhook signing key from an owner-managed Secret. The existing
  defaults work with the Secret absent, and the release scripts were kept as-is.
- **Weekly email.** Chose Resend, explicit account-menu consent tied to the
  verified primary address, and a Thursday 7 pm New York delivery window. The
  email uses a rotating prompt and the saved-place count. It has one-click
  unsubscribe headers and a confirmation page for the visible link. One
  attempt per account per week avoids duplicates after an ambiguous provider
  failure. The first CI run found an omitted entry in the exact grants matrix.
  The corrected matrix and delivery integration passed 20 tests on disposable
  Postgres. Migration up/down/up and production web builds with the flag on and
  off passed.
- **Preview plan.** Defaulted to Union Square and proposed a picker for the
  three focus neighborhoods, one reviewed sample per day, a bounded public
  endpoint and the existing sign-up handoff.

Web and API tests, lint and typecheck ran before opening the task PRs. Web
changes in this session also passed a production build with a placeholder API
origin. CI status above refers to the listed head commits.

## Owner decisions and setup

1. Approve the new category exclusions in #131. Review and merge the PRs you want.
2. For Clerk, choose whether to migrate development identities and whether to
   keep Restricted sign-up and the shared demo. Follow #132 for the Clerk
   production instance, Cloudflare records, Vercel keys, API Secrets, webhook,
   and controlled verification. Schedule the matched API/web cutover yourself.
3. For weekly email, review the additive migration and set up Resend, the
   sending domain records, a sender and postal address, the send-only key and
   unsubscribe signing key. Follow #133 for the exact Secret keys and flags.
   Keep production email off until a controlled recipient can verify delivery
   and unsubscribe.
4. Approve the public preview's scope and example prompts before implementation.

The requested coding and planning work is complete. After approving the preview
plan, use this prompt to continue.

> Implement the approved public daily quest preview from PR #134 on a new
> branch from the latest main. Keep it off by default, use the neighborhood
> picker without geolocation, test the public limits and sign-up handoff, and
> open one PR without merging or deploying.
