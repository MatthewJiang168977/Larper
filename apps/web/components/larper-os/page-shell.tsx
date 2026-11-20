import type { ReactNode } from "react";
import { larperOsClassName } from "@/app/larper-os";
import { OSMenuBar, OSWindow } from "./primitives";
import "./landing.css";
import "./page-shell.css";

export function LarperOsPageShell({ title, children, wide = false }: {
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <main className={`${larperOsClassName} larper-landing larper-os-page`}>
      <OSMenuBar />
      <div className="larper-landing-stage">
        <div className={wide ? "larper-os-page-window larper-os-page-window-wide" : "larper-os-page-window"}>
          <OSWindow title={title} titleAs="h1">{children}</OSWindow>
        </div>
      </div>
    </main>
  );
}
