# Larper design system

Larper's interface is **Larper OS**: a small retro desktop. A pink desktop, cream windows with a
striped title bar, a menu bar, chunky buttons with an offset shadow, pixel titles. This file
describes what the code does today. Where it says "enforced by", a test fails if it drifts.

Sources of truth, in order: `apps/web/app/larper-os.css` (tokens), `apps/web/app/larper-os.ts`
(fonts), `apps/web/components/larper-os/` (components and their CSS), `apps/web/components/map/`
(map palettes), `apps/web/test/design-tokens.test.ts` (rules in CSS).

## Tokens

Defined on `.larper-os` (`app/larper-os.css`). Every Larper OS page puts `larperOsClassName`
(`app/larper-os.ts`) on its root, which sets these and loads the fonts. Never write a literal
colour in a component; use a token.

### Colour

| Token | Value | Use |
|---|---|---|
| `--larper-os-ink` | `#000000` | text, borders, shadows, focus rings |
| `--larper-os-window` | `#f9efe4` | window and menu bar background, button face |
| `--larper-os-paper` | `#fffdf8` | panels and form fields inside a window |
| `--larper-os-pink` | `#f6d5d5` | the desktop behind every window (same as the day map) |
| `--larper-os-butter` | `#f7e2a4` | hover, pressed toggles, confirmations |
| `--larper-os-pool` / `-hover` | `#1e95a1` / `#17838e` | the one primary action on a screen |
| `--larper-os-red` | `#a32a36` | links and errors |
| `--larper-os-coral` | `#e8756f` | fills only |
| `--larper-os-aqua`, `--larper-os-mint` | `#b9e3e6`, `#d5e7c8` | tints |
| `--larper-os-disabled` / `-ink` | `#e9e1d8` / `#5c5552` | disabled fills; muted text |

Pool and coral fills take black text only. Ink, red and disabled-ink must stay at 4.5:1 or better
on `--larper-os-window` (enforced by `test/design-tokens.test.ts`).

`app/globals.css` still holds an older "field journal" token set (`--paper`, `--ink`,
`--ink-label`, Fraunces and JetBrains Mono) used by a few older surfaces and by Clerk's code
field. New work uses the `--larper-os-*` tokens.

### Shape, shadow, size, time

| Token | Value | Use |
|---|---|---|
| `--larper-os-radius-window` | 7px | windows, panels, buttons |
| `--larper-os-radius-tag` | 5px | small chips, form fields |
| `--larper-os-shadow-raised` | `1px 2px 0 ink` | buttons and panels: a hard offset, never blurred |
| `--larper-os-shadow-primary` | `2px 3px 0 ink` | the primary button |
| `--larper-os-shadow-window` | soft drop, `rgb(120 64 64 / 30%)` | the only blurred shadow: a window over the desktop |
| `--larper-os-tap-min` | 44px | minimum height and width of anything pressable |
| `--larper-os-dock-width` | 520px | the quest sheet's width on large screens |
| `--larper-os-dur-pop` / `-press` | 160ms / 90ms | opening and pressing |

Borders are 1px ink. The primary button is the exception at 2px.

### Type

- **Jersey 20** (`--larper-os-font-pixel`): titles and labels at display sizes only: the brand
  (24px), window titles (23px), buttons (25px) and large lead numbers. Never for sentences.
- **Atkinson Hyperlegible Next** (`--larper-os-font-body`): everything else. Numerals inside pixel
  text below 28px use `.num` (body font, 0.86em, weight 600) so they stay legible.
- Both fall back to `system-ui`. Fonts are not preloaded; they load when their CSS is used.

## Components

All in `components/larper-os/primitives.tsx` with their CSS in `primitives.css`.

| Component | Use it for | Notes |
|---|---|---|
| `OSMenuBar` | the top bar on every page: "larper os" and page controls | cream, 1px bottom rule, 45px tall |
| `OSWindow` | any block of content, with a striped title bar from `title` | `titleAs="h1"` when it is the page's heading, otherwise a span. `footer` for a quiet note row |
| `OSQuestPanel` | a raised paper card inside a window | `role="status"` or `"alert"` for live messages |
| `OSButton` | an action. `primary` for the one main action | native `<button>`; type defaults to `button` |
| `OSDesktopIcon` | an icon-only square action (44px) | give it an accessible name; `aria-pressed` for toggles |
| `QuestFlag` | the quest icon | decorative (`aria-hidden`) |

Page shells that compose them: `LarperOsPageShell` (a titled page: privacy, terms, credits, weekly
email), `LarperOsAuthShell` (sign-in and sign-up), and the landing, journal, onboarding and
your-data views. A link that should look like a button uses the class `larper-os-button` (or
`osPrimaryButtonClass`). Clerk's forms are themed from `components/auth/clerk-appearance.ts` with
the same tokens, and sit inside the OS window instead of using Clerk's own card as a frame.

States, as in `primitives.css`: hover is butter (only where hover exists); pressed inverts to ink on
window; disabled is dashed, flat and `not-allowed`; focus is a 2px ink outline with a 2px offset.

## Layout

- Pages are a menu bar plus a stage with one or two windows. Window widths: auth and content pages
  28rem (content pages 42rem when `wide`), the quest dock 520px.
- The quest screen is a full-viewport map with a bottom sheet (`quest-sheet.tsx`).
- Corners: new windows and panels use `--larper-os-radius-window`; do not invent a radius.

## Motion

- Short: pop 160ms, press 90ms. Nothing blocks input; animation never delays content.
- The quest sheet and the done stamp use `motion/react` (a spring with `stiffness 420,
  damping 40`, and a 100ms shake on a refused check-in).
- Reduced motion: transitions are off under `prefers-reduced-motion: reduce`, the map's palette
  blend is pinned (see Map phases), and `useReducedMotion` gates the JS animation. New motion must
  do the same.
- No smooth-scroll libraries, particles, glass or blur effects.

## Copy

- UI labels are lowercase and short: "journal", "sign in", "delete my history", "try the demo".
- Full sentences and error messages use sentence case with a full stop. Place names keep their
  capitals ("The Basement Record Shop").
- Say what happened and what to do next, plainly: "That code isn't right. Check it and try again."
  Never blame, never exclaim, no jargon.
- Never put a place, address or time in an image or a share card.
- Some older journal and your-data sentences are lowercase; sentence case is the rule for new copy.

## Map phases

The map is drawn in Larper OS colours and follows the sun over New York
(`components/map/map-daylight.ts`, palettes in `larper-os-style.ts`). The phase comes from the
sun's altitude and differs in the morning and the afternoon:

| Phase | When (altitude) | Paper | Water | Park | Label |
|---|---|---|---|---|---|
| night | below -6° | `#251e29` | `#070B1F` | `#25352c` | `#f9efe4` |
| dawn | morning, -6° to 8° | `#EADFEE` | `#BFD8EE` | `#CFE2C9` | `#2E2A48` |
| day | morning above 8°, afternoon above 12° | `#f6d5d5` | `#a9dde3` | `#cde6be` | `#3a2432` |
| golden | afternoon, 2° to 12° | `#F7D8A6` | `#93CBC9` | `#CBD68F` | `#3E2610` |
| dusk | afternoon, below 2° | `#F2A58F` | `#8E9BDC` | `#CFA88F` | `#2A1236` |

Each phase is exact where it begins and blends into the next one's palette before it ends, so
nothing jumps. Reduced motion pins the blend to zero: a palette stays exact until its threshold,
then is replaced. `map-contrast.test.ts` holds labels to 4.5:1 and streets and buildings to 3:1
against the land, in every phase.

## Accessibility rules

- Every pressable thing is at least 44 x 44 (`--larper-os-tap-min`). Inline text links inside a
  sentence are the only exception.
- Focus is always visible: 2px ink outline, 2px offset. Never remove an outline without replacing it.
- Text contrast is at least 4.5:1 on its surface; large text and map line work at least 3:1.
- Do not use colour alone: states and errors also say it in words.
- Live messages use `role="status"` (polite) or `role="alert"` (urgent).
- Respect `prefers-reduced-motion` everywhere (see Motion).
- One `h1` per page, and a window's `aria-labelledby` points at its title.
