import { ViewTransition } from "react";

// A fresh template per route, so moving between pages is a transition: the new page
// opens like a window (app/larper-transitions.css). Browsers without the View
// Transitions API, and people who asked for reduced motion, get no animation at all.
export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <ViewTransition enter="larper-window-open" exit="larper-window-close" default="none">
      {children}
    </ViewTransition>
  );
}
