import Link from "next/link";
import "./landing.css";

/**
 * Privacy, terms and credits, on every page where someone signs up or uses Larper: the
 * landing page, sign-in and sign-up (Terms says using Larper means agreeing to it), and
 * the journal. 44px targets (landing.css).
 */
export function LegalLinks() {
  return (
    <nav aria-label="about larper" className="larper-landing-about">
      <Link href="/privacy" className="larper-landing-about-link">privacy</Link>
      <Link href="/terms" className="larper-landing-about-link">terms</Link>
      <Link href="/credits" className="larper-landing-about-link">credits</Link>
    </nav>
  );
}
