import { Jersey_20 } from "next/font/google";
import localFont from "next/font/local";
import "./larper-os.css";

// SIL OFL 1.1 for both families
// https://github.com/google/fonts/blob/main/ofl/atkinsonhyperlegiblenext/OFL.txt
// https://github.com/google/fonts/blob/main/ofl/jersey20/OFL.txt
// Latin variable WOFF2 from Google Fonts, licensed in fonts/Atkinson-Hyperlegible-Next-OFL.txt.
// Local loading computes fallback metrics from the font instead of Next's incomplete family table.
const atkinson = localFont({
  src: "./fonts/atkinson-hyperlegible-next-latin.woff2",
  weight: "200 800",
  style: "normal",
  variable: "--larper-os-font-body",
  adjustFontFallback: "Arial",
  preload: false,
});

const jersey = Jersey_20({
  variable: "--larper-os-font-pixel",
  weight: "400",
  subsets: ["latin"],
  preload: false,
});

// The home route serves both landing and quests. Load these faces when their CSS is used.
export const larperOsClassName = `larper-os ${atkinson.variable} ${jersey.variable}`;
