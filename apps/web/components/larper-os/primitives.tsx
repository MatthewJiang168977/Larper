import type { ComponentProps, ReactNode } from "react";
import "./primitives.css";

export const osPrimaryButtonClass = "larper-os-button larper-os-button-primary";

export function OSMenuBar({ children }: { children?: ReactNode }) {
  return (
    <header className="larper-os-menu">
      <span className="larper-os-brand">larper os</span>
      {children}
    </header>
  );
}

export function OSWindow({ title, children, footer }: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="larper-os-window" aria-label={title}>
      <div className="larper-os-titlebar">
        <span className="larper-os-grille" aria-hidden="true" />
        <span>{title}</span>
        <span className="larper-os-grille" aria-hidden="true" />
      </div>
      <div className="larper-os-body">{children}</div>
      {footer && <footer className="larper-os-footer">{footer}</footer>}
    </section>
  );
}

export function OSButton({ primary = false, type = "button", ...props }:
  Omit<ComponentProps<"button">, "className"> & { primary?: boolean }
) {
  return <button {...props} type={type} className={primary ? osPrimaryButtonClass : "larper-os-button"} />;
}

export function OSDesktopIcon({ type = "button", ...props }:
  Omit<ComponentProps<"button">, "className">
) {
  return <button {...props} type={type} className="larper-os-icon" />;
}

export function QuestFlag() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 21V3m0 1h12l-3 4 3 4H6" />
    </svg>
  );
}

export function OSQuestPanel({ children, role }: {
  children: ReactNode;
  role?: "status" | "alert";
}) {
  return <div className="larper-os-panel" role={role}>{children}</div>;
}
