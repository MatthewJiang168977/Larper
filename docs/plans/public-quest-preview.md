# Public daily quest preview

**Status** — proposed, plan only.

Give visitors on `/` one example of what a Larper quest asks them to do. Keep
the sample readable before sign-up and independent of a real quest offer.

## Visitor flow

1. The signed-out landing page shows a preview beside its existing entry actions.
   The default is Union Square. A labeled picker can switch to East Village
   or Greenwich Village, using the existing focus-area names. No browser location
   permission or coordinate input is needed. Keep the choice in memory for the
   current visit.
2. Show one short challenge per neighborhood and New York calendar day. Use
   reviewed prompts such as “Find a bookstore and pick something by its first
   sentence.” Include the neighborhood and category, with a visible **sample
   quest** label. Exact venue data becomes available through the signed-in flow.
3. Keep the active sign-up mode authoritative. Open signup leads to **start a
   quest log**. Restricted signup keeps **try the demo** and the existing sign-in
   link for people with invitations. After sign-up, onboarding and the signed-in
   map run normally. A preview creates no quest, reserves no venue and grants
   no completion or saved-place credit.

## API and abuse limits

- Add `GET /public/quest-preview?neighborhood=union-square`, gated off until
  review. Validate the slug against the three supported values and reject other
  parameters. The public response exposes only the date, neighborhood label,
  category and prompt. No IDs, coordinates, website links, user data, taste
  data, counts, deck, or pagination.
- Use a small curated catalog of evergreen prompts. Precompute the three
  responses by day and cache them with a TTL capped at the next New York
  midnight and a short shared max-age. Ignore identity and cookies. A cache
  miss must stay cheap and must never trigger ingest, candidate queries,
  Clerk calls, or a database write.
- Use the API's trusted client-IP resolution and shared Redis rate limiting.
  Retain the existing outer IP limit and start with a route-specific
  10 requests per minute and 60 per hour per IP. Use one shared budget for
  cache misses across replicas, keyed to the preview route rather than
  the slug. Return 429 with Retry-After when over limit. If the limiter or
  preview data is unavailable, serve the normal landing page without a
  preview. Keep the endpoint and its cache key bounded to the day and
  three slugs.
- Treat prompts as intentionally public. Limits protect resources, not the
  confidentiality of public text. Avoid credentialed cross-origin fetches,
  hidden identifiers and analytics capture of the picker. If measuring the
  CTA later, use one explicit cookieless event with no neighborhood or location.

## Effort and risk

| Work | Estimate | Acceptance |
| --- | --- | --- |
| Curate three sets of prompts and add the response schema | Half day | Same day and slug give the same single sample. Blank or invalid data falls back gracefully. |
| Add the public API, cache, and limits | One day | Contract and rate-limit tests cover input, races, expiry and a Redis outage. No private fields or writes. |
| Add the Larper OS card and handoff | One day | Keyboard and mobile coverage, 44px targets, visible focus, production build with request-time auth inside Suspense. Verify both sign-up modes. |

Risks are stale or misleading “today” copy, quota exhaustion from shared networks,
and visitors expecting the sample to transfer into their account. Keep the sample
label clear, use a low-cost payload, and keep sign-up usable if the preview fails.
Review the initial prompts and neighborhood names before building. Use the
[industry-ready plan](industry-ready-plan.md) for rollout and recruiting context.
