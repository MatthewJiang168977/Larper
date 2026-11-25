// The public demo. Sign-ups are by invitation (Clerk's Restricted mode,
// NEXT_PUBLIC_SIGNUP_MODE=restricted), so a visitor signs in as one shared account
// with a one-time sign-in token from the API (POST /demo/sign-in). No password to
// show, and no email code: the account has no inbox, and a token skips Clerk's
// new-device check. scripts/demo-account.sh creates the account; it's reset nightly.
import { larperOsAuthAppearance } from "./clerk-appearance";

export const demoEnabled = (signUpMode: string | undefined) => signUpMode === "restricted";

// Sign-in has a heading and no subtitle. With sign-ups restricted (Clerk's Restricted mode:
// invitations only), its "Don't have an account? Sign up" footer would also lead nowhere.
export function signInAppearance(signUpMode: string | undefined) {
  const elements = { ...larperOsAuthAppearance.elements, headerSubtitle: { display: "none" } };
  return {
    ...larperOsAuthAppearance,
    elements: demoEnabled(signUpMode) ? { ...elements, footerAction: { display: "none" } } : elements,
  };
}
