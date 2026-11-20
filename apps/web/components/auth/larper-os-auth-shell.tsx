import type { ReactNode } from "react";
import { larperOsClassName } from "@/app/larper-os";
import { OSMenuBar, OSWindow } from "@/components/larper-os/primitives";
import "@/components/larper-os/landing.css";
import "./larper-os-auth.css";

export function LarperOsAuthShell({ title, children }: {
  title: "sign in" | "sign up";
  children: ReactNode;
}) {
  return (
    <main className={`${larperOsClassName} larper-landing larper-os-auth`}>
      <OSMenuBar />
      <div className="larper-landing-stage">
        <div className="larper-os-auth-window">
          <OSWindow title={title}>{children}</OSWindow>
        </div>
      </div>
    </main>
  );
}
