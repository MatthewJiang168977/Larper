import type { ReactNode } from "react";
import { larperOsClassName } from "@/app/larper-os";
import { OSWindow } from "@/components/larper-os/primitives";
import { AuthMenuBar } from "./auth-menu-bar";
import { AuthWallpaper } from "./auth-wallpaper";
import "./larper-os-auth.css";
import "./larper-os-account-window.css";

// "about this explorer": a window docked over the wallpaper (right on a wide screen, bottom on a
// phone), with the menu bar in reach. Not a modal: nothing is dimmed.
export function AccountFrame({ children }: { children: ReactNode }) {
  return (
    <main className={`${larperOsClassName} larper-os-auth larper-account`}>
      <AuthWallpaper />
      <AuthMenuBar page="account" />
      <p className="larper-account-credit">
        map © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>,{" "}
        <a href="https://openmaptiles.org/">OpenMapTiles</a>
      </p>
      <div className="larper-account-dock">
        <OSWindow
          title="about this explorer"
          titleAs="h1"
          footer={<><span>larper os 3.1</span><span aria-hidden="true">128 mb of opinions</span></>}
        >
          {children}
        </OSWindow>
      </div>
    </main>
  );
}
