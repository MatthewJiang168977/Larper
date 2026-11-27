import type { ReactNode } from "react";
import { larperOsClassName } from "@/app/larper-os";
import { LegalLinks } from "@/components/larper-os/legal-links";
import { OSWindow } from "@/components/larper-os/primitives";
import "@/components/larper-os/landing.css";
import { AuthMenuBar } from "./auth-menu-bar";
import { AuthRoot } from "./auth-wallpaper";
import "./larper-os-auth.css";

const PAGES = {
  "sign in": { title: "sign in", intro: "welcome back. today's quest is waiting." },
  "sign up": { title: "new account", intro: "one quest a day, picked for you." },
} as const;

// Everything around Clerk's form: one window over the wallpaper, a one-line intro, Clerk's
// form, then `demo`.
export function LarperOsAuthShell({ page, children, demo }: {
  page: "sign in" | "sign up";
  children: ReactNode;
  demo?: ReactNode;
}) {
  return (
    <AuthRoot className={`${larperOsClassName} larper-os-auth larper-auth-page`}>
      <AuthMenuBar page={page} />
      <div className="larper-auth-stage">
        <OSWindow title={PAGES[page].title} titleAs="h1" footer={<LegalLinks />}>
          <p className="larper-auth-intro">{PAGES[page].intro}</p>
          <div className="larper-auth-form">{children}</div>
          {demo}
        </OSWindow>
        {/* The wallpaper is a picture of the map, so it carries the map's credit. */}
        <p className="larper-auth-credit">
          map © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>,{" "}
          <a href="https://openmaptiles.org/">OpenMapTiles</a>
        </p>
      </div>
    </AuthRoot>
  );
}
