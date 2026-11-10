import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Larper OS design lab",
  robots: { index: false, follow: false },
};

export default function DesignLabLayout({ children }: { children: ReactNode }) {
  if (process.env.VERCEL_ENV === "production" ||
      (process.env.VERCEL_ENV !== "preview" && process.env.NODE_ENV !== "development")) {
    notFound();
  }

  return children;
}
