import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata, Viewport } from "next";
import { Fraunces, JetBrains_Mono } from "next/font/google";
import { CLERK_APPEARANCE } from "@/components/auth/clerk-appearance";
import "./globals.css";

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
  themeColor: "#f2ead8",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${fraunces.variable} ${jetbrains.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <ClerkProvider appearance={CLERK_APPEARANCE}>{children}</ClerkProvider>
      </body>
    </html>
  );
}
