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

// The signed-in app's menu bar (the quest screen's): the wordmark on the left. Here the
// date and time sit on the right, and sign-up keeps a way to sign-in.
export function AuthMenuBar({ page }: { page: "sign in" | "sign up" }) {
  return (
    <header className="larper-auth-menu">
      <span className="larper-auth-brand">larper</span>
      <div>
        <Clock />
        {page === "sign up" && <Link href="/sign-in" className="larper-auth-menu-link">sign in</Link>}
      </div>
    </header>
  );
}
