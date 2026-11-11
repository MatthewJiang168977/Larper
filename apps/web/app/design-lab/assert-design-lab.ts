import { notFound } from "next/navigation";

export function assertDesignLab() {
  if (process.env.VERCEL_ENV === "production" ||
      (process.env.VERCEL_ENV !== "preview" && process.env.NODE_ENV !== "development")) {
    notFound();
  }
}
