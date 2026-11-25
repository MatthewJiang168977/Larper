import type { ClerkProvider } from "@clerk/nextjs";
import type { ComponentProps } from "react";

// Larper's words on Clerk's sign-in and sign-up. Wording only: Clerk's steps, checks and
// security behaviour are unchanged. Clerk takes this on the provider, not on each form.
export const larperOsLocalization: NonNullable<ComponentProps<typeof ClerkProvider>["localization"]> = {
  socialButtonsBlockButton: "continue with {{provider|titleize}}",
  dividerText: "or",
  formFieldLabel__emailAddress: "email address",
  formButtonPrimary: "continue",
  signIn: { start: { title: "sign in to larper", titleCombined: "sign in to larper" } },
  signUp: { start: { title: "welcome in.", subtitle: "one quest a day, picked for you." } },
};
