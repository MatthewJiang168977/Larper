import Link from "next/link";
import type { ReactNode } from "react";
import "./primitives.css";

export function OSNavigation({ page, mapHref = "/", hideMapLink = false, account }: {
  page: "map" | "journal";
  mapHref?: string;
  hideMapLink?: boolean;
  account?: ReactNode;
}) {
  const brand = hideMapLink
    ? <span className="larper-os-menu-item larper-os-menu-brand">larper</span>
    : <Link href={mapHref} className="larper-os-menu-item larper-os-menu-brand" aria-current={page === "map" ? "page" : undefined}>larper</Link>;

  return (
    <nav className="larper-os-navigation" aria-label="Larper">
      {page === "map" ? <h1>{brand}</h1> : brand}
      {hideMapLink
        ? <span className="larper-os-menu-item" aria-current="page">journal</span>
        : <Link href="/journal" className="larper-os-menu-item" aria-current={page === "journal" ? "page" : undefined}>journal</Link>}
      {account}
    </nav>
  );
}
