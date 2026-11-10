import { Atkinson_Hyperlegible_Next, Jersey_20 } from "next/font/google";
import "./larper-os.css";

// SIL OFL 1.1 for both families
// https://github.com/google/fonts/blob/main/ofl/atkinsonhyperlegiblenext/OFL.txt
// https://github.com/google/fonts/blob/main/ofl/jersey20/OFL.txt
const atkinson = Atkinson_Hyperlegible_Next({
  variable: "--larper-os-font-body",
  adjustFontFallback: false,
  preload: false,
});

const jersey = Jersey_20({
  variable: "--larper-os-font-pixel",
  weight: "400",
  preload: false,
});

// Import from redesigned surfaces so the legacy layout does not load these fonts.
export const larperOsClassName = `larper-os ${atkinson.variable} ${jersey.variable}`;
