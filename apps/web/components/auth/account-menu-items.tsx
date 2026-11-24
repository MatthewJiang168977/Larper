import { UserButton } from "@clerk/nextjs";

// The account menu's items, in Larper's order. "sign out" is Clerk's own last item.
// UserButton looks for MenuItems among its direct children, so this is a function that
// returns the element, not a component.
const icon = (path: string) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d={path} />
  </svg>
);

const ICONS = {
  journal: icon("M5 4h12a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2zM9 8h6M9 12h6"),
  data: icon("M12 4c4.4 0 8 1.1 8 2.5S16.4 9 12 9 4 7.9 4 6.5 7.6 4 12 4zM4 6.5v11C4 18.9 7.6 20 12 20s8-1.1 8-2.5v-11"),
  privacy: icon("M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6z"),
  email: icon("M3 5h18v14H3zM4 7l8 6 8-6"),
  account: icon("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c0-3.3 3.6-6 8-6s8 2.7 8 6"),
};

export function accountMenuItems({ weeklyEmail = false }: { weeklyEmail?: boolean } = {}) {
  return (
    <UserButton.MenuItems>
      <UserButton.Action label="manageAccount" />
      <UserButton.Link label="journal" href="/journal" labelIcon={ICONS.journal} />
      <UserButton.Link label="your data" href="/journal#your-data" labelIcon={ICONS.data} />
      {weeklyEmail && <UserButton.Link label="weekly email" href="/account/weekly-email" labelIcon={ICONS.email} />}
      <UserButton.Link label="privacy" href="/privacy" labelIcon={ICONS.privacy} />
    </UserButton.MenuItems>
  );
}
