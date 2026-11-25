import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import { Fraunces, JetBrains_Mono } from "next/font/google";
import { AnalyticsAuth } from "@/components/analytics-auth";
import { CLERK_APPEARANCE } from "@/components/auth/clerk-appearance";
import { larperOsLocalization } from "@/components/auth/clerk-localization";
import { WebAnalytics } from "@/components/web-analytics";
import "./globals.css";
import { larperOsClassName } from "./larper-os";
import "@/components/auth/larper-os-clerk.css";

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["opsz", "SOFT"],
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Larper",
  description: "The most niche thing to do near you.",
  applicationName: "Larper",
  appleWebApp: { capable: true, title: "Larper", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#f6d5d5", // Larper OS pink (--larper-os-pink), the page behind every window
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${fraunces.variable} ${jetbrains.variable} h-full antialiased`}>
      <body className={`${larperOsClassName} flex min-h-full flex-col`}>
        <ClerkProvider appearance={CLERK_APPEARANCE} localization={larperOsLocalization}>
          <AnalyticsAuth />
          {children}
        </ClerkProvider>
        <WebAnalytics />
      </body>
    </html>
  );
}
