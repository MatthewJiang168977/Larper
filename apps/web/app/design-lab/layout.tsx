import type { Metadata } from "next";
import type { ReactNode } from "react";
import { assertDesignLab } from "./assert-design-lab";

export const metadata: Metadata = {
  title: "Larper OS design lab",
  robots: { index: false, follow: false },
};

export default function DesignLabLayout({ children }: { children: ReactNode }) {
  assertDesignLab();
  return children;
}
