import Link from "next/link";
import type { ReactNode } from "react";
import { larperOsClassName } from "@/app/larper-os";
import { OSMenuBar, OSQuestPanel, OSWindow } from "./primitives";
import "./landing.css";

export function LarperLanding({ actions, preview = false }: { actions: ReactNode; preview?: boolean }) {
  return (
    <main className={`${larperOsClassName} larper-landing`}>
      <OSMenuBar>{preview && <span>design preview</span>}</OSMenuBar>
      <div className="larper-landing-stage">
        <div className="larper-landing-dock">
          <OSWindow title="side_quests.txt" footer="New York City, for now">
            <OSQuestPanel>
              <h1 className="larper-landing-title">larper</h1>
              <p>one quest a day: the most niche spot near you that fits your taste.</p>
            </OSQuestPanel>
            <OSQuestPanel>
              <h2 className="larper-landing-list-title">now offering</h2>
              <ul className="larper-landing-list">
                <li>hojicha soft serve in a mall basement.</li>
                <li>a photobooth bar.</li>
                <li>the dumpling counter with no sign.</li>
              </ul>
            </OSQuestPanel>
            <div className="larper-landing-actions">{actions}</div>
            <Link href="/privacy" className="larper-landing-privacy">privacy</Link>
          </OSWindow>
        </div>
      </div>
    </main>
  );
}
