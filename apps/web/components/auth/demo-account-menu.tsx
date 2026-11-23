"use client";

import { SignOutButton } from "@clerk/nextjs";
import { useEffect, useRef, useState } from "react";
import { OSButton } from "@/components/larper-os/primitives";
import "./larper-os-account-menu.css";

export function DemoAccountMenu() {
  const menu = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);

  // A press anywhere outside closes it. Not on any blur: Safari and Firefox on macOS don't
  // focus a button that is clicked, so the blur a click on "sign out" causes has no related
  // target, and closing then could hide the button before the click landed.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  return (
    <details
      ref={menu}
      className="larper-os-demo-account"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onBlur={(event) => {
        // Keyboard: tabbing out of the menu closes it. A blur with no related target is
        // left to the pointerdown handler above.
        const to = event.relatedTarget;
        if (to && !event.currentTarget.contains(to)) event.currentTarget.open = false;
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !event.currentTarget.open) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.open = false;
        trigger.current?.focus();
      }}
    >
      <summary className="larper-os-button" ref={trigger}>account</summary>
      <div className="larper-os-demo-account-panel">
        <SignOutButton>
          <OSButton>sign out</OSButton>
        </SignOutButton>
      </div>
    </details>
  );
}
