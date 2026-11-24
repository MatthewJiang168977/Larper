# Move Larper to Clerk production

This procedure is for the owner. It changes live authentication, DNS, and deployment
settings. Rehearse locally with test keys, then schedule a cutover that leaves time
to verify both the web app and API. Keep the previous Vercel deployment, API
configuration, and Clerk development instance available for rollback.

## 1. Set up the production instance

- [ ] Create a Production instance from the existing Clerk app and set its application
  domain to `playlarper.com`. Review sign-in methods, signup restrictions, invitation
  settings, OAuth credentials, and paths individually. Clerk does not copy users,
  OAuth credentials, integrations, or paths into a fresh production instance.
- [ ] Decide what to do with existing development accounts before the switch. Larper
  associates its records with Clerk user IDs. A signup with the same email does not
  reconnect an old journal. Rehearse any migration with a test identity and confirm
  that the intended Clerk ID can access that user's Larper data. Finish pending
  development-instance Clerk deletions before rotating the API key.
- [ ] Turn off **Allow users to delete their accounts** in the production instance.
  Account deletion should begin from **your data** in Larper's journal. Check in a
  disposable account's Clerk profile that the direct delete option is absent.

References [Clerk production deployment](https://clerk.com/docs/guides/development/deployment/production),
[Larper deletion design](../decisions/0005-data-deletion.md).

## 2. Verify DNS and redirects

- [ ] In Cloudflare, add the exact names and targets Clerk lists for `playlarper.com`.
  They cover the Clerk Frontend API, Account Portal, email routing and DKIM, as
  applicable. Set Clerk CNAMEs to **DNS only**. Leave the existing application and
  API records for `playlarper.com` and `api.playlarper.com` in place.
- [ ] Check that a public DNS resolver returns each expected record and that Clerk
  marks the domain, records, and certificates ready. Resolve certificate issues
  before changing the app keys. The hostname encoded by the new publishable key is
  the API's expected token issuer and JWKS host.
- [ ] Set and verify sign-in and sign-up paths `/sign-in` and `/sign-up` on
  `https://playlarper.com`. Use `/` as the fallback for both. Configure any OAuth
  callbacks with the exact URLs Clerk and the provider specify. Test an invited
  signup, sign-in from a protected page such as `/journal`, and sign-out.
- [ ] Keep API CORS and Clerk's authorized parties restricted to the web app's
  exact origin `https://playlarper.com`. The Oracle deployment derives both from
  `WEB_ORIGIN`. Keep localhost and preview hosts on their own development settings.

Reference [Clerk DNS, certificates and authorized parties](https://clerk.com/docs/guides/development/deployment/production).

## 3. Prepare the keys and demo

| Destination | Configuration |
| --- | --- |
| Vercel, **Production** environment | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` from the production instance, its matching `CLERK_SECRET_KEY` as a server-only secret, and `NEXT_PUBLIC_API_URL=https://api.playlarper.com`. Check the four Clerk path/fallback variables against [the web example](../../apps/web/.env.example). |
| API, Kubernetes namespace `larper` | Create the owner-managed Secret `clerk-production-runtime` with key `publishableKey` set to the **same** publishable key. The Oracle profile passes it to the verifier as `CLERK_PUBLISHABLE_KEY_OVERRIDE`. Without it the chart uses its existing fallback. |
| API, owner deploy input | Put the production `CLERK_SECRET_KEY` in an untracked, access-restricted file pointed to by `WEB_ENV`. The owner-run `scripts/oci-up.sh` writes `clerk-privacy` under key `secretKey`, and writes the matching key to `clerk-demo` if a demo ID is configured. Keep the signing secret separate from this key. |

- [ ] Keep the previous environment values in a protected place. Confirm the app
  publishable key and API verifier override both come from the production instance.
  Do not put real keys in source, build output logs, or PRs. Preview and Development
  environments can keep their test keys.
- [ ] If retaining the shared demo, provision a **new production-instance demo user**.
  Update the owner-local `DEMO_ENV` with the new `DEMO_USER_ID`; the development
  user ID does not transfer. Verify that **try the demo** signs in as that user,
  check-ins stay simulated and the data controls are denied. Verify the nightly reset
  against that same ID. Keep demo and real accounts separate.
- [ ] Match `NEXT_PUBLIC_SIGNUP_MODE` to the launch decision. In Restricted mode,
  Larper shows **try the demo** and Clerk signups need an invitation. Opening signup
  changes the landing CTA to account creation. Verify the intended flow before
  sending invitations.

## 4. Connect user deletion and cut over

- [ ] Create the production Clerk webhook for
  `https://api.playlarper.com/webhooks/clerk`, subscribed to `user.deleted`.
  Store its `whsec_` signing secret under `signingSecret` in the owner-managed
  `clerk-production-runtime` Secret. The Oracle values set
  `privacy.clerkWebhook.secretName` to that Secret. Until the signing key is present
  the API endpoint responds 404. Keep `privacy.deletes` at `all`.
- [ ] In the cutover window, roll the API with the production verifier override,
  privacy key, webhook signing key and optional production demo ID. Then deploy the
  Vercel Production build with the matching keys. The two deployments can briefly
  disagree, which causes API authentication failures. Expect old sessions to sign in
  again. Keep the window closed to new users until the following checks pass.
- [ ] With a disposable invited account, verify sign-up, a signed-in `GET /me` and
  journal load, reload in a new browser tab, and sign-out. Confirm a carried-over
  development session cannot call the production API.
- [ ] With disposable accounts, verify the two deletion paths. First delete via
  Larper and confirm the Clerk account is gone. Then remove a different disposable
  Clerk account as the administrator and check the signed delivery gets a success
  response and its Larper data is purged. A repeat delivery should also succeed.
  Use only disposable accounts that you intend to delete.
- [ ] If verification fails, stop invitations. Restore the prior Vercel deployment
  and prior API Clerk inputs together, retire or disable the production webhook
  during rollback, and verify development sign-in and the demo again. Preserve
  accounts and data created during the window for the next attempt.

Reference [Clerk webhook setup and delivery](https://clerk.com/docs/guides/development/webhooks/syncing).
