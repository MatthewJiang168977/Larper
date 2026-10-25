// Clerk's sign-in, sign-up, user menu and avatar, inked onto the field journal.
// Set once on <ClerkProvider>. Colours are the globals.css tokens as var(): Clerk's
// UI (@clerk/ui, loaded from its CDN) passes them through on modern browsers, the
// same way its own shadcn theme does. Every text pair here is AA on --paper:
// ink 12.1:1, ink-soft 6.0:1 (5.3:1 on --paper-deep), oxblood 7.8:1.

// The app's :focus-visible ring (globals.css). Clerk sets its own focus styles with a
// class, which beats the :where() rule, so its controls get the ring here.
const focusRing = { outline: "2px solid var(--oxblood)", outlineOffset: "3px", boxShadow: "none" };

// .stamp-btn: ink border, hard offset shadow, presses down on click. No gradient.
const stamp = {
  backgroundImage: "none",
  border: "1.5px solid var(--ink)",
  boxShadow: "2px 2px 0 var(--ink)",
  transition: "transform 80ms, box-shadow 80ms",
  // Clerk draws its sheen on solid buttons as an ::after layer.
  "&::after": { display: "none" },
  "&:active": { transform: "translate(2px, 2px)", boxShadow: "0 0 0 var(--ink)" },
  "&:focus-visible": { ...focusRing, boxShadow: "2px 2px 0 var(--ink)" },
};

const oxbloodLink = { color: "var(--oxblood)", "&:hover": { color: "var(--oxblood)" } };

// Like the demo panel under the sign-in form: paper, a ruled edge, no lift.
const paperCard = { backgroundColor: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "0.25rem", boxShadow: "none" };

// Ink-on-paper avatar: a paper-deep disc with an ink rim. (Its initials come from
// avatarInitialsAppearance; an uploaded photo covers the disc as usual.)
const avatarBox = {
  backgroundColor: "var(--paper-deep)",
  border: "1px solid var(--ink)",
  color: "var(--ink)",
  alignItems: "center",
  justifyContent: "center",
};

export const CLERK_APPEARANCE = {
  // Clerk's plain base: no sheen, layered shadows or ring-borders to fight below.
  theme: "simple" as const,
  variables: {
    colorPrimary: "var(--ink)",
    colorPrimaryForeground: "var(--paper)",
    colorDanger: "var(--oxblood)",
    colorNeutral: "var(--ink)",
    colorForeground: "var(--ink)",
    colorMutedForeground: "var(--ink-soft)",
    colorMuted: "var(--paper-deep)",
    colorBackground: "var(--paper)",
    colorInput: "var(--paper)",
    colorInputForeground: "var(--ink)",
    colorBorder: "var(--ink-faint)",
    colorRing: "var(--oxblood)",
    colorShadow: "var(--ink)",
    colorModalBackdrop: "var(--ink)",
    // The app's one face (body and headings), and its label mono.
    fontFamily: "var(--font-fraunces), Georgia, serif",
    fontFamilyButtons: "var(--font-fraunces), Georgia, serif",
    fontFamilyMono: "var(--font-jetbrains), ui-monospace, monospace",
    // Square corners: stamps, not pills. The card and avatar set their own below.
    borderRadius: "0",
  },
  elements: {
    cardBox: paperCard,
    card: { backgroundColor: "var(--paper)", boxShadow: "none", border: "none" },
    footer: { background: "var(--paper)", borderTop: "1px solid var(--rule)" },
    headerTitle: { fontFamily: "var(--font-fraunces), Georgia, serif", fontWeight: 600, letterSpacing: "-0.01em" },
    headerSubtitle: { color: "var(--ink-soft)" },
    formButtonPrimary: {
      ...stamp,
      backgroundColor: "var(--ink)",
      color: "var(--paper)",
      "&:hover": { backgroundColor: "var(--ink)" },
    },
    socialButtonsBlockButton: { ...stamp, backgroundColor: "var(--paper)", color: "var(--ink)" },
    alternativeMethodsBlockButton: { ...stamp, backgroundColor: "var(--paper)", color: "var(--ink)" },
    formFieldInput: {
      backgroundColor: "var(--paper)",
      border: "1px solid var(--ink-faint)",
      boxShadow: "none",
      "&:hover": { borderColor: "var(--ink-soft)" },
      "&:focus, &:focus-visible": { ...focusRing, borderColor: "var(--ink)" },
    },
    otpCodeFieldInput: { borderColor: "var(--ink-faint)", "&:focus, &:focus-visible": { ...focusRing, borderColor: "var(--ink)" } },
    button: { "&:focus-visible": focusRing },
    footerActionLink: oxbloodLink,
    formFieldAction: oxbloodLink,
    formResendCodeLink: oxbloodLink,
    identityPreviewEditButton: oxbloodLink,
    backLink: oxbloodLink,
    headerBackLink: oxbloodLink,
    dividerLine: { backgroundColor: "var(--rule)" },
    formFieldErrorText: { color: "var(--oxblood)" },
    userButtonPopoverCard: paperCard,
    userButtonPopoverMain: { backgroundColor: "var(--paper)" },
    userButtonPopoverFooter: { background: "var(--paper)", borderTop: "1px solid var(--rule)" },
    avatarBox,
  },
};

type AvatarUser = {
  hasImage: boolean;
  firstName: string | null;
  lastName: string | null;
  username?: string | null;
  primaryEmailAddress?: { emailAddress: string } | null;
};

/** Up to two initials for a user: names first, then the username or email. */
export function avatarInitials(user: AvatarUser): string {
  const names = [user.firstName, user.lastName].map((n) => n?.trim()).filter(Boolean) as string[];
  const fallback = user.username?.trim() || user.primaryEmailAddress?.emailAddress.trim() || "";
  const letters = names.length ? names.map((n) => [...n][0]) : fallback ? [[...fallback][0]] : [];
  return letters.join("").toUpperCase();
}

// Clerk gives a user with no photo a generated violet image, which its avatar always
// shows over its own initials. For those users, hide that image and draw the initials
// in ink on the paper disc instead. A photo the user uploaded still shows.
export function avatarInitialsAppearance(user: AvatarUser | null | undefined) {
  const initials = user && !user.hasImage ? avatarInitials(user) : "";
  if (!initials) return undefined;
  return {
    elements: {
      avatarImage: { display: "none" },
      avatarBox: {
        // Sized to the disc, whichever avatar this is (28 px trigger, larger in the menu).
        containerType: "size",
        "&::after": {
          content: JSON.stringify(initials),
          fontFamily: "var(--font-fraunces), Georgia, serif",
          fontWeight: 600,
          fontSize: "42cqi",
          lineHeight: 1,
          color: "var(--ink)",
        },
      },
    },
  };
}
