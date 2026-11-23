const osInk = "var(--larper-os-ink)";
const osPaper = "var(--larper-os-paper)";
const osWindow = "var(--larper-os-window)";
const osRed = "var(--larper-os-red)";
const osMutedInk = "var(--larper-os-disabled-ink)";
const osFocus = { outline: `2px solid ${osInk}`, outlineOffset: "2px", boxShadow: "none" };
const osLink = {
  color: osRed,
  textDecoration: "underline",
  textUnderlineOffset: "0.15em",
  "&:hover": { color: osRed },
  "&:focus-visible": osFocus,
};
const osButton = {
  minHeight: "var(--larper-os-tap-min)",
  border: `1px solid ${osInk}`,
  backgroundColor: osPaper,
  backgroundImage: "none",
  color: osInk,
  boxShadow: "var(--larper-os-shadow-raised)",
  transition: "none",
  "&:hover": { backgroundColor: "var(--larper-os-butter)", color: osInk },
  "&:active": { transform: "none", backgroundColor: osInk, color: osPaper },
  "&:focus-visible": osFocus,
  "&:disabled": {
    backgroundColor: "var(--larper-os-disabled)",
    color: osMutedInk,
    boxShadow: "none",
  },
};
const osField = {
  minHeight: "var(--larper-os-tap-min)",
  backgroundColor: osPaper,
  border: `1px solid ${osInk}`,
  boxShadow: "none",
  transition: "none",
  "&::placeholder": { color: osMutedInk, opacity: 1 },
  "&:focus, &:focus-visible": osFocus,
};

export const CLERK_APPEARANCE = {
  theme: "simple" as const,
  variables: {
    colorPrimary: "var(--larper-os-pool)",
    colorPrimaryForeground: osInk,
    colorDanger: osRed,
    colorNeutral: osInk,
    colorForeground: osInk,
    colorMutedForeground: osMutedInk,
    colorMuted: osWindow,
    colorBackground: osWindow,
    colorInput: osPaper,
    colorInputForeground: osInk,
    colorBorder: osInk,
    colorRing: osInk,
    colorShadow: osInk,
    colorModalBackdrop: osInk,
    fontFamily: "var(--larper-os-font-body), system-ui, sans-serif",
    fontFamilyButtons: "var(--larper-os-font-body), system-ui, sans-serif",
    fontFamilyMono: "var(--font-jetbrains), ui-monospace, monospace",
    borderRadius: "var(--larper-os-radius-tag)",
  },
  elements: {
    cardBox: { backgroundColor: osWindow, border: `1px solid ${osInk}`, boxShadow: "var(--larper-os-shadow-window)" },
    card: { backgroundColor: osWindow, boxShadow: "none" },
    footer: { background: osWindow, borderTop: `1px solid ${osInk}` },
    headerTitle: {
      fontFamily: "var(--larper-os-font-pixel), system-ui, sans-serif",
      fontWeight: 400,
      fontSize: "clamp(26px, 6vw, 32px)",
      letterSpacing: "normal",
      overflowWrap: "anywhere",
    },
    headerSubtitle: { color: osMutedInk, overflowWrap: "anywhere" },
    formButtonPrimary: {
      ...osButton,
      backgroundColor: "var(--larper-os-pool)",
      "&:hover": { backgroundColor: "var(--larper-os-pool-hover)", color: osInk },
    },
    socialButtonsBlockButton: osButton,
    alternativeMethodsBlockButton: osButton,
    formFieldInput: osField,
    otpCodeFieldInput: osField,
    button: { "&:focus-visible": osFocus },
    footerActionLink: osLink,
    formFieldAction: osLink,
    formResendCodeLink: osLink,
    identityPreviewEditButton: osLink,
    backLink: osLink,
    headerBackLink: osLink,
    dividerLine: { backgroundColor: osInk },
    formFieldErrorText: { color: osRed },
    modalContent: "larper-os larper-os-clerk-modal",
    modalCloseButton: { "&:focus-visible": osFocus },
    userButtonPopoverCard: { backgroundColor: osWindow, border: `1px solid ${osInk}` },
    userButtonPopoverMain: { backgroundColor: osWindow },
    userButtonPopoverFooter: { background: osPaper, borderTop: `1px solid ${osInk}` },
    avatarBox: {
      backgroundColor: osWindow,
      border: `1px solid ${osInk}`,
      color: osInk,
      alignItems: "center",
      justifyContent: "center",
    },
  },
};

// These forms sit inside an OSWindow, which supplies the surrounding chrome.
export const larperOsAuthAppearance = {
  variables: CLERK_APPEARANCE.variables,
  elements: {
    ...CLERK_APPEARANCE.elements,
    rootBox: { width: "100%", minWidth: 0 },
    cardBox: { width: "100%", maxWidth: "100%", backgroundColor: osWindow, border: "none", boxShadow: "none" },
    card: { width: "100%", padding: "16px", backgroundColor: osWindow },
  },
};

export function larperOsAccountMenuAppearance(osClassName: string) {
  return {
    elements: {
      userButtonTrigger: "larper-quest-menu-link larper-quest-clerk-trigger",
      userButtonBox: "larper-quest-clerk-trigger-avatar",
      userButtonPopoverRootBox: "larper-os-account-menu-root",
      // The popover can render in a portal. Carry the OS tokens and fonts with it.
      userButtonPopoverCard: `${osClassName} larper-os-account-menu`,
      userButtonPopoverMain: "larper-os-account-menu-main",
      userPreviewTextContainer: "larper-os-account-menu-identity",
      userPreviewMainIdentifier: "larper-os-account-menu-name",
      userPreviewMainIdentifierText: "larper-os-account-menu-name",
      userPreviewSecondaryIdentifier: "larper-os-account-menu-email",
      userButtonPopoverActionButton: "larper-os-account-menu-action",
      userButtonPopoverActionButtonIconBox: "larper-os-account-menu-icon",
      userButtonPopoverFooter: "larper-os-account-menu-footer",
    },
  };
}

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
          fontFamily: "var(--larper-os-font-body), system-ui, sans-serif",
          fontWeight: 600,
          fontSize: "42cqi",
          lineHeight: 1,
          color: osInk,
        },
      },
    },
  };
}

export function userProfileAppearance(user: AvatarUser | null | undefined) {
  return {
    elements: {
      rootBox: "larper-os-clerk-profile",
      navbar: "larper-os-clerk-profile-nav",
      navbarButton: "larper-os-clerk-profile-nav-button",
      profileSectionTitle: "larper-os-clerk-profile-title",
      profileSectionPrimaryButton: osLink,
      ...avatarInitialsAppearance(user)?.elements,
    },
  };
}
