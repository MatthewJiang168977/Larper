// The shared demo account, shown on the sign-in page when it's configured
// (NEXT_PUBLIC_DEMO_EMAIL / NEXT_PUBLIC_DEMO_PASSWORD, public on purpose: anyone may
// use it). scripts/demo-account.sh creates it and resets it.
export function DemoAccount({ email, password }: { email?: string; password?: string }) {
  if (!email || !password) return null;
  return (
    <section aria-label="Demo account" className="w-full max-w-sm rounded border border-rule bg-paper px-4 py-3 text-sm">
      <p className="field-label">Just looking?</p>
      <p className="mt-1">Sign in with the shared demo account:</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
        <dt className="text-ink-label">Email</dt>
        <dd className="select-all break-all">{email}</dd>
        <dt className="text-ink-label">Password</dt>
        <dd className="select-all break-all">{password}</dd>
      </dl>
      <p className="mt-2 text-xs text-ink-label">Everyone shares it, and its quests are reset now and then.</p>
    </section>
  );
}

// With sign-ups restricted (Clerk's Restricted mode: invitations only), the sign-in
// form's "Don't have an account? Sign up" link would lead nowhere.
export const signInAppearance = (signUpMode: string | undefined) =>
  signUpMode === "restricted" ? { elements: { footerAction: { display: "none" } } } : undefined;
