"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PixelArt } from "@/components/larper-os/pixel-art";

const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** "12:40 pm", and on wide screens "wed 25 nov · 12:40 pm": the visitor's own clock. */
export function clockParts(now: Date) {
  return {
    date: dateFormat.format(now).replace(",", "").toLowerCase(),
    time: timeFormat.format(now).replace(/\s/g, " ").toLowerCase(),
  };
}

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const timer = setInterval(tick, 5_000);
    return () => clearInterval(timer);
  }, []);
  if (!now) return null;
  const { date, time } = clockParts(now);
  return (
    <time className="larper-auth-clock" dateTime={now.toISOString()}>
      <span className="larper-auth-clock-date">{date} · </span>{time}
    </time>
  );
}

// The menu bar over the wallpaper. On sign-in there is no "sign in" item: the visitor is already
// there. The account window is signed in: journal, and "me" as where you are.
export function AuthMenuBar({ page }: { page: "sign in" | "sign up" | "account" }) {
  return (
    <header className="larper-auth-menu">
      <nav aria-label="main">
        <Link href="/" className="larper-auth-logo" aria-label="larper home"><PixelArt name="logo" /></Link>
        <Link href="/">larper</Link>
        {page === "account" && <Link href="/journal">journal</Link>}
      </nav>
      <div>
        <Clock />
        {page === "sign up" && <Link href="/sign-in">sign in</Link>}
        {page === "account" && <Link href="/account" aria-current="page">me</Link>}
      </div>
    </header>
  );
}
