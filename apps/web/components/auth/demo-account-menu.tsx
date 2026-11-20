"use client";

import { SignOutButton } from "@clerk/nextjs";
import { useRef } from "react";
import { OSButton } from "@/components/larper-os/primitives";
import "./larper-os-account-menu.css";

export function DemoAccountMenu() {
  const trigger = useRef<HTMLElement>(null);

  return (
    <details
      className="larper-os-demo-account"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
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
