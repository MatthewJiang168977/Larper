import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { larperOsClassName } from "../larper-os";
import { QuestFixture } from "./quest-fixture";

export const metadata: Metadata = {
  title: "Larper OS design lab",
  robots: { index: false, follow: false },
};

export default function DesignLab() {
  if (process.env.VERCEL_ENV === "production" ||
      (process.env.VERCEL_ENV !== "preview" && process.env.NODE_ENV !== "development")) {
    notFound();
  }

  return <main className={larperOsClassName}><QuestFixture /></main>;
}
