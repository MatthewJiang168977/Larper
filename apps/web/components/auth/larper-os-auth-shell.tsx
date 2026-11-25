import type { ReactNode } from "react";
import { larperOsClassName } from "@/app/larper-os";
import { LegalLinks } from "@/components/larper-os/legal-links";
import { PixelArt } from "@/components/larper-os/pixel-art";
import { OSWindow } from "@/components/larper-os/primitives";
import "@/components/larper-os/landing.css";
import { AuthMenuBar } from "./auth-menu-bar";
import { AuthMiniMap, AuthWallpaper } from "./auth-wallpaper";
import { QuestTeaser } from "./quest-teaser";
import "./larper-os-auth.css";

const TITLES = { "sign in": "sign_in.exe", "sign up": "new_account.exe" } as const;

function LogonBand() {
  return (
    <div className="larper-auth-band">
      <span className="larper-auth-usericon" aria-hidden="true"><PixelArt name="pigeon" /></span>
      <p>larper os 3.1<small>side-quest edition</small></p>
    </div>
  );
}

// Everything around Clerk's form. `demo` goes under the form on a phone; `demoWindow` is its
// own window beside sign-in on a wide screen. The CSS shows one of the two.
export function LarperOsAuthShell({ page, children, demo, demoWindow }: {
  page: "sign in" | "sign up";
  children: ReactNode;
  demo?: ReactNode;
  demoWindow?: ReactNode;
}) {
  return (
    <main className={`${larperOsClassName} larper-os-auth`}>
      <AuthWallpaper />
      <AuthMenuBar page={page} />
      <div className="larper-auth-stage">
        <div className="larper-auth-column">
          <OSWindow
            title={TITLES[page]}
            footer={<><span>signal: new york city, for now</span><span aria-hidden="true">:-)</span></>}
          >
            <LogonBand />
            <QuestTeaser page={page} layout="strip" />
            <div className="larper-auth-split">
              <div className="larper-auth-pane">
                <AuthMiniMap />
                <QuestTeaser page={page} layout="card" />
              </div>
              <div className="larper-auth-form">
                {children}
                {demo}
              </div>
            </div>
          </OSWindow>
          <div className="larper-auth-about">
            <LegalLinks />
            {/* The wallpaper is a picture of the map, so it carries the map's credit. */}
            <p>
              map © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>,{" "}
              <a href="https://openmaptiles.org/">OpenMapTiles</a>
            </p>
          </div>
        </div>
        {demoWindow && <div className="larper-auth-demo-window">{demoWindow}</div>}
      </div>
    </main>
  );
}
