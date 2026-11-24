import type { ClerkProvider } from "@clerk/nextjs";
import type { ComponentProps } from "react";

// Passed to <ClerkProvider localization>: Clerk takes it there, not on each form.
type LocalizationResource = NonNullable<ComponentProps<typeof ClerkProvider>["localization"]>;

// Larper's voice for the strings Clerk shows on sign-in and sign-up: lowercase labels,
// sentence case for full sentences and errors. Wording only: Clerk's flows, checks and
// security behaviour are unchanged.
const errors = {
  form_identifier_not_found: "We can't find an account with that email.",
  form_password_incorrect: "That password isn't right. Try again.",
  form_password_or_identifier_incorrect: "That email or password isn't right. Try again.",
  form_code_incorrect: "That code isn't right. Check it and try again.",
  form_param_nil: "Fill this in to continue.",
  form_param_format_invalid: "That doesn't look right. Check it and try again.",
  form_param_format_invalid__email_address: "Enter a full email address, like name@example.com.",
  form_identifier_exists__email_address: "An account with that email already exists. Try signing in.",
  form_password_length_too_short: "Use a longer password.",
  form_password_pwned: "That password has appeared in a data leak. Choose a different one.",
  form_password_pwned__sign_in: "That password has appeared in a data leak. Reset it to keep your account safe.",
  not_allowed_access: "Larper isn't open to new sign-ups with that email yet.",
  oauth_access_denied: "Google sign-in was cancelled. Try again, or use your email.",
  session_exists: "You're already signed in.",
} as const;

export const larperOsLocalization: LocalizationResource = {
  socialButtonsBlockButton: "continue with {{provider|titleize}}",
  dividerText: "or",
  formFieldLabel__emailAddress: "email",
  formFieldLabel__emailAddress_username: "email",
  formFieldLabel__password: "password",
  formFieldInputPlaceholder__emailAddress: "you@example.com",
  formButtonPrimary: "continue",
  formFieldAction__forgotPassword: "forgot password?",
  signIn: {
    start: {
      title: "sign in",
      subtitle: "welcome back. today's quest is waiting.",
      actionText: "New to Larper?",
      actionLink: "sign up",
    },
  },
  signUp: {
    start: {
      title: "sign up",
      subtitle: "one quest a day, picked for you.",
      actionText: "Already have an account?",
      actionLink: "sign in",
    },
  },
  unstable__errors: errors,
};
