// The Larper OS card used for share images and the app icons: a pink desktop, a cream
// window with a striped title bar. System sans only (no font fetch at build). No places,
// addresses or times ever go in here.
import type { ReactElement } from "react";

const INK = "#000000";
const WINDOW = "#f9efe4";
const PINK = "#f6d5d5";
const POOL = "#1e95a1";

function stripes(height: number): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flex: 1,
        height,
        backgroundImage: `repeating-linear-gradient(${INK} 0 2px, ${WINDOW} 2px 6px)`,
      }}
    />
  );
}

export function OgCard({ title = "larper", line = "one niche quest a day, picked for you." }: { title?: string; line?: string }) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: PINK }}>
      <div
        style={{
          width: 900, display: "flex", flexDirection: "column", background: WINDOW,
          border: `4px solid ${INK}`, borderRadius: 20, boxShadow: `10px 14px 0 ${INK}`, overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "14px 24px", borderBottom: `4px solid ${INK}` }}>
          {stripes(28)}
          <div style={{ fontSize: 34, fontWeight: 700, color: INK }}>larper os</div>
          {stripes(28)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", padding: "56px 64px 64px", gap: 20 }}>
          <div style={{ fontSize: 168, lineHeight: 1, fontWeight: 800, color: INK, letterSpacing: -4 }}>{title}</div>
          <div style={{ fontSize: 46, lineHeight: 1.25, color: INK }}>{line}</div>
          <div style={{ display: "flex", marginTop: 12 }}>
            <div style={{ display: "flex", padding: "14px 32px", background: POOL, border: `4px solid ${INK}`, borderRadius: 10, boxShadow: `4px 6px 0 ${INK}`, fontSize: 38, fontWeight: 700, color: INK }}>
              try today&apos;s quest
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The app icon: a window with a striped title bar and an L. `inset` keeps it inside a maskable icon's safe zone. */
export function IconCard({ size, inset = 0 }: { size: number; inset?: number }) {
  const win = size - inset * 2;
  const bar = Math.round(win * 0.2);
  return (
    <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", background: PINK }}>
      <div
        style={{
          width: win, height: win, display: "flex", flexDirection: "column", background: WINDOW,
          border: `${Math.max(2, Math.round(win * 0.02))}px solid ${INK}`, borderRadius: Math.round(win * 0.1), overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex", height: bar, borderBottom: `${Math.max(2, Math.round(win * 0.02))}px solid ${INK}`,
            backgroundImage: `repeating-linear-gradient(${INK} 0 ${Math.max(1, Math.round(win * 0.012))}px, ${WINDOW} ${Math.max(1, Math.round(win * 0.012))}px ${Math.round(win * 0.04)}px)`,
          }}
        />
        <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", fontSize: Math.round(win * 0.62), fontWeight: 800, color: INK }}>
          l
        </div>
      </div>
    </div>
  );
}
