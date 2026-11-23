"use client";

import { SignOutButton } from "@clerk/nextjs";
import { useEffect, useId, useRef, useState } from "react";
import { OSButton } from "@/components/larper-os/primitives";
import "./larper-os-account-menu.css";

export function DemoAccountMenu() {
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [open, setOpen] = useState(false);

  // A press anywhere outside closes it. Not on any blur: Safari and Firefox on macOS don't
  // focus a button that is clicked, so the blur a click on "sign out" causes has no related
  // target, and closing then could hide the button before the click landed.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  return (
    <div
      ref={menu}
      className="larper-os-demo-account"
      onBlur={(event) => {
        // Keyboard: tabbing out of the menu closes it. A blur with no related target is
        // left to the pointerdown handler above.
        const to = event.relatedTarget;
        if (to && !event.currentTarget.contains(to)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      <button
        type="button"
        className="larper-quest-menu-link"
        ref={trigger}
        aria-controls={panelId}
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        account
      </button>
      <div id={panelId} className="larper-os-demo-account-panel" hidden={!open}>
        <SignOutButton>
          <OSButton>sign out</OSButton>
        </SignOutButton>
      </div>
    </div>
  );
}
