import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import { Fraunces, JetBrains_Mono } from "next/font/google";
import { AnalyticsAuth } from "@/components/analytics-auth";
import { CLERK_APPEARANCE } from "@/components/auth/clerk-appearance";
import { ToastProvider } from "@/components/larper-os/toaster";
import { WebAnalytics } from "@/components/web-analytics";
import "./globals.css";
import "./larper-transitions.css";
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
  // Absolute URLs for the share images (app/opengraph-image.tsx).
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://playlarper.com"),
  title: "Larper",
  description: "The most niche thing to do near you.",
  applicationName: "Larper",
  appleWebApp: { capable: true, title: "Larper", statusBarStyle: "default" },
  icons: { icon: [{ url: "/favicon.ico", sizes: "any" }, { url: "/icon.svg", type: "image/svg+xml" }], apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#f9efe4", // Larper OS window cream (--larper-os-window), the menu bar
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${fraunces.variable} ${jetbrains.variable} h-full antialiased`}>
      <body className={`${larperOsClassName} flex min-h-full flex-col`}>
        <ClerkProvider appearance={CLERK_APPEARANCE}>
          <AnalyticsAuth />
          <ToastProvider>{children}</ToastProvider>
        </ClerkProvider>
        <WebAnalytics />
      </body>
    </html>
  );
}
