# Weekly quest email

**Status** — pilot code, off by default.

Use Resend’s per-recipient email API. At the time of review its free tier includes
3,000 API sends per month and 100 per day. That fits the initial 15-person pilot and
supports custom one-click unsubscribe headers. Brevo offers 300 daily sends on
its free tier and is a fallback if the pilot needs more daily headroom. The
provider boundary accepts one message at a time and tests use a mock.
[Resend pricing](https://resend.com/pricing) ·
[Resend unsubscribe headers](https://www.resend.com/blog/gmail-and-yahoo-bulk-sending-requirements-for-2024/) ·
[Brevo plans](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans)

## Consent and delivery

- A real, signed-in user opens **weekly email** in the account menu and chooses
  **subscribe**. No one starts opted in. The demo cannot subscribe. Consent is
  tied to the verified primary address identity in Clerk. If the address changes,
  delivery stops for that address and the user can opt out and subscribe again to
  confirm the new one.
- Send from 7 pm Thursday in `America/New_York`, with five-minute checks until
  midnight so DST and a short restart do not move the local send day. The job
  records one attempt per account per send day before contacting the provider.
  Concurrent API replicas skip claimed rows. An ambiguous provider failure
  misses that week's email, and the next week progresses normally. The provider
  also gets an idempotency key.
- Each email carries a rotating quest prompt, the line “You have N saved places,”
  and a link to Larper's home page. No exact location, place or quest IDs, saved
  names, coordinates, or personal taste data go into the message. There are no
  analytics events, tracking pixels or tracked links.
- Mail-client one-click unsubscribe uses the signed
  `List-Unsubscribe` and `List-Unsubscribe-Post` POST. The visible email link
  opens a confirmation with one unsubscribe button, so scanner GETs cannot
  silently change consent. Both paths require no login. Opting out clears the
  address identity and token. An old token cannot opt out a new subscription.
- Larper reads the address from Clerk for delivery and does not store the address
  itself. Postgres stores the chosen address identity, opt-in timestamp, random
  unsubscribe ID and last attempt day. Data export includes the opt-in timestamp
  and attempt day. Account deletion cascades the row. The provider receives the
  email address and message content. Review the provider’s retention and
  tracking settings before enabling it.

## Owner setup

1. Create a Resend account on the intended plan. Add and verify a sending domain,
   preferably a dedicated subdomain of `playlarper.com`. Add the DNS records
   Resend supplies for SPF and DKIM and verify the domain's DMARC policy. Disable
   open and click tracking. Choose an accurate sender and a valid postal address
   for the footer. [FTC commercial email guidance](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)
2. Create a send-only API key restricted to that sending domain. Create the
   owner-managed `weekly-email` Secret in namespace `larper` with
   `WEEKLY_EMAIL_RESEND_KEY`, `WEEKLY_EMAIL_FROM`,
   `WEEKLY_EMAIL_POSTAL_ADDRESS`, `WEEKLY_EMAIL_APP_ORIGIN=https://playlarper.com`,
   `WEEKLY_EMAIL_API_ORIGIN=https://api.playlarper.com`, and
   `WEEKLY_EMAIL_UNSUBSCRIBE_KEY` (32 random bytes encoded as unpadded base64url).
   The API uses its existing `CLERK_SECRET_KEY` to check verified addresses.
   Keep these credentials outside Git and logs.
3. Apply migration `0022_weekly_email` through the normal release before the new
   API pods start. Rehearse delivery and opt-out with controlled recipients in
   an isolated environment. Leave both flags off on the public app until the pilot.
   When ready,
   set `WEEKLY_EMAIL_ENABLED=1` in the Secret, roll the API, then build the web
   app with `NEXT_PUBLIC_WEEKLY_EMAIL_ENABLED=1`. Verify a new account is
   unsubscribed, one opted-in test account gets the expected Thursday email, and
   both unsubscribe paths stop it. Keep the pilot within the provider's daily
   limit before inviting a larger group.
4. To pause sending, remove the server enable value and turn off the web flag.
   Keep the unsubscribe signing key and database migration so already delivered
   links still work.
