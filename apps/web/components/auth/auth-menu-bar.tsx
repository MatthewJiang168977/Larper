"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** "wed 25 nov" and "12:40 pm": the visitor's own clock. */
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
  return <time className="larper-auth-clock" dateTime={now.toISOString()}>{date} · {time}</time>;
}

// The signed-in app's menu bar (the quest screen's): the wordmark on the left. Here the date and
// time sit on the right, and sign-up keeps a way to sign-in. The account window is signed in:
// journal beside the wordmark, and "me" as where you are.
export function AuthMenuBar({ page }: { page: "sign in" | "sign up" | "account" }) {
  return (
    <header className="larper-auth-menu">
      <div>
        <span className="larper-auth-brand">larper</span>
        {page === "account" && <Link href="/journal" className="larper-auth-menu-link">journal</Link>}
      </div>
      <div>
        <Clock />
        {page === "sign up" && <Link href="/sign-in" className="larper-auth-menu-link">sign in</Link>}
        {page === "account" && <Link href="/account" className="larper-auth-menu-link" aria-current="page">me</Link>}
      </div>
    </header>
  );
}
