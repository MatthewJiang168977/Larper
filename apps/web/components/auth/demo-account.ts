// The public demo. Sign-ups are by invitation (Clerk's Restricted mode,
// NEXT_PUBLIC_SIGNUP_MODE=restricted), so a visitor signs in as one shared account
// with a one-time sign-in token from the API (POST /demo/sign-in). No password to
// show, and no email code: the account has no inbox, and a token skips Clerk's
// new-device check. scripts/demo-account.sh creates the account; it's reset nightly.
import { larperOsAuthAppearance } from "./clerk-appearance";

export const demoEnabled = (signUpMode: string | undefined) => signUpMode === "restricted";

// With sign-ups restricted (Clerk's Restricted mode: invitations only), the sign-in
// form's "Don't have an account? Sign up" link would lead nowhere.
export const signInAppearance = (signUpMode: string | undefined) =>
  demoEnabled(signUpMode)
    ? {
        ...larperOsAuthAppearance,
        elements: { ...larperOsAuthAppearance.elements, footerAction: { display: "none" } },
      }
    : larperOsAuthAppearance;
