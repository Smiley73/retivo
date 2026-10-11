---
name: RETIVO
description: Graphite Spectrum — a calm, numbers-first instrument for self-directed retirement planning.
colors:
  surface: "oklch(0.985 0.002 264)"
  surface-raised: "oklch(1 0 0)"
  surface-sunken: "oklch(0.965 0.003 264)"
  ink: "oklch(0.18 0.015 264)"
  muted: "oklch(0.47 0.012 264)"
  line: "oklch(0.89 0.005 264)"
  line-strong: "oklch(0.82 0.008 264)"
  input-line: "oklch(0.62 0.012 264)"
  accent: "oklch(0.45 0.09 165)"
  accent-ink: "oklch(0.99 0 0)"
  accent-link: "oklch(0.48 0.11 163)"
  accent-subtle: "oklch(0.95 0.03 165)"
  positive: "oklch(0.52 0.16 145)"
  negative: "oklch(0.50 0.18 25)"
  warning: "oklch(0.52 0.13 70)"
  info: "oklch(0.50 0.14 240)"
  pretax: "oklch(0.50 0.18 260)"
  roth: "oklch(0.46 0.20 320)"
  taxable: "oklch(0.50 0.13 200)"
  cash: "oklch(0.52 0.13 70)"
  tax_free: "oklch(0.50 0.10 185)"
typography:
  display:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontSize: "clamp(1.5rem, 3vw, 2rem)"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Hanken Grotesk, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    letterSpacing: "0.04em"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    fontFeature: "tnum"
rounded:
  sm: "6px"
  md: "10px"
  lg: "16px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "11px 17px"
  button-primary-hover:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
  button-ghost:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "11px 17px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "24px"
  badge:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.muted}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
---

# Design System: RETIVO

## 1. Overview

**Creative North Star: "The Precise Instrument"**

This is the dashboard of a well-made financial instrument, not a marketing
surface. Cool graphite neutrals recede so the numbers carry the page; a single
pine money-green accent does the pointing; and five type-coded account-bucket hues
(iris, violet, cyan, amber, teal) let the eye sort pre-tax / Roth / taxable / cash /
tax-free (HSA) at a glance. Tabular numerals are set in a monospace face so columns of money line up
to the digit. The whole system is built in OKLCH and flips light↔dark as a pure
variable swap, so contrast is engineered, not approximated.

The voice is quiet and confident. Chrome stays out of the way, motion is reserved
for state changes, and nothing cheerleads over an inconvenient figure. The system
exists to make a careful person *trust the math* — so legibility and contrast are
the non-negotiables, and decoration is rationed.

This system explicitly rejects the **generic SaaS dashboard** (stock indigo-on-slate,
hero-metric cards, identical icon+heading+text grids), the **salesy fintech / robo-advisor**
look (gamified confetti, "you're on track!" nudges that hide the numbers), the
**spreadsheet / legacy-finance** wall of undifferentiated gray, and the
**consumer-cute** register (mascots, pastels, emoji). Money decisions earn a
serious surface.

**Key Characteristics:**
- Graphite neutrals + one pine money-green accent; color is rationed, never sprayed.
- Five account-bucket hues, always paired with a label — never hue alone.
- Monospace tabular numerals for every column of money.
- WCAG 2.2 AA engineered into every token pair, both themes.
- Dark mode is a variable swap; no `dark:` color twins anywhere.

## 2. Colors

A cool graphite spectrum (hue ~264) for every neutral, one pine money-green accent
(with a lighter sibling for link text), and five deliberately separated bucket hues
so account types stay scannable. Dark mode re-points the same token names; the
values below are the light theme. The accent sits at hue ~165, deliberately apart
from the gains-`positive` green (hue ~145), so a button never reads as a gain.

### Primary
- **Pine** (`oklch(0.45 0.09 165)`): the sole accent. Used as a **fill** with a
  white label on top (primary buttons, active-nav wash, selected segment, progress
  fill). The same deep value carries both themes. Too dark to vary as text across
  themes, so links use `accent-link` (below), not the fill.
- **Accent Ink** (`oklch(0.99 0 0)`, white): the label that rides on the pine fill
  (white-on-pine 7.06:1, both themes).
- **Accent Link** (`oklch(0.48 0.11 163)` light / `oklch(0.70 0.12 163)` dark): the
  lighter green for link / secondary-button / active-nav text — legible as text on
  both surfaces, where the deep fill is not. This is the role iris used to double
  for; freeing it returns iris to meaning pre-tax accounts only.

### Secondary — Account Buckets
The five type-coded hues that make balances sortable at a glance. Each ships with
a `-subtle` tint for chip fills.
- **Iris** (`oklch(0.50 0.18 260)`): pre-tax accounts.
- **Violet** (`oklch(0.46 0.20 320)`): Roth accounts.
- **Cyan** (`oklch(0.50 0.13 200)`): taxable accounts.
- **Amber** (`oklch(0.52 0.13 70)`): cash accounts.
- **Teal** (`oklch(0.50 0.10 185)`): tax-free (HSA) accounts.

### Tertiary — Semantic States
- **Positive Green** (`oklch(0.52 0.16 145)`): gains, success, net-positive change.
- **Negative Red** (`oklch(0.50 0.18 25)`): losses, shortfall, destructive zones.
- **Warning Amber** (`oklch(0.52 0.13 70)`): modified / caution.
- **Info Blue** (`oklch(0.50 0.14 240)`): neutral informational accents.

### Neutral — The Graphite Spectrum
- **Surface** (`oklch(0.985 0.002 264)`): the document background.
- **Surface Raised** (`oklch(1 0 0)`): cards, charts, raised panels.
- **Surface Sunken** (`oklch(0.965 0.003 264)`): wells, neutral chips, disabled fills.
- **Ink** (`oklch(0.18 0.015 264)`): primary body text and headings.
- **Muted** (`oklch(0.47 0.012 264)`): secondary text, hints, metadata. Clears
  4.5:1 — not a decorative light gray.
- **Line** (`oklch(0.89 0.005 264)`): hairline decorative borders (WCAG 1.4.11-exempt).
- **Line Strong** (`oklch(0.82 0.008 264)`): structural dividers, ghost-button borders.
- **Input Line** (`oklch(0.62 0.012 264)`): control borders — darker so it clears
  the 3.0 non-text gate in both themes.

### Named Rules
**The One Voice Rule.** The pine accent is the only accent. It appears on a small
fraction of any screen (primary action, active state). Its rarity is what makes
it read as "the thing to do next." Never introduce a second competing accent.

**The Label-Never-Hue Rule.** Account-bucket color is redundant encoding, never the
sole signal. Every bucket hue is paired with a text label so the meaning survives
color blindness and grayscale.

**The Engineered-Contrast Rule.** Every UI and chart color pair is registered in
`lib/contrast.ts` and proven AA in `contrast.test.ts`, both themes. A new color
pairing is not "done" until its pair is in the allowlist and passes.

## 3. Typography

**Display / Body Font:** Hanken Grotesk (with `system-ui, sans-serif`) — a
self-hosted variable font (latin subset), one family across the whole UI in
multiple weights.
**Numeral / Mono Font:** JetBrains Mono (with `ui-monospace, monospace`) — for
tabular figures so money columns align to the digit.

**Character:** One humanist grotesk doing all the talking, paired on a real
contrast axis (proportional sans vs. monospace) only where numbers demand it.
Hierarchy comes from weight and size, not from a zoo of typefaces. The page
baseline is a deliberate **14px (0.875rem)** — compact, instrument-grade density.

### Hierarchy
- **Display** (700, `clamp(1.5rem, 3vw, 2rem)`, 1.15): page titles in the header.
- **Title** (600, 1.125rem, 1.3): section and card headings.
- **Body** (400, 0.875rem, 1.5): default text, table cells, form values. Cap prose
  at 65–75ch.
- **Label** (500, 0.75rem, +0.04em tracking): field labels, sidebar section
  headers, metadata pills. Uppercase only on short metadata labels (≤4 words).
- **Mono** (400, 0.875rem, `tnum`): every dollar amount, percentage, and column of
  figures.

### Named Rules
**The Tabular-Money Rule.** Any number a user compares vertically (balances,
returns, projections) is set in JetBrains Mono with tabular figures. Proportional
digits in a money column are forbidden — they make the eye work to align.

**The 14px Baseline Rule.** Body is 14px, not 16px. This is an information-dense
instrument; resist bumping the baseline "for comfort" — comfort comes from
hierarchy and spacing, not from inflating every line.

## 4. Elevation

Near-flat by default. Depth comes from tonal layering of the three graphite
surfaces (`surface` → `surface-raised` → `surface-sunken`) plus a single hairline
border, with only a whisper of shadow on raised cards. There is no heavy
drop-shadow vocabulary; the system reads as etched, not stacked.

### Shadow Vocabulary
- **Card lift** (`shadow-sm`, Tailwind's `0 1px 2px 0 rgb(0 0 0 / 0.05)`): the only
  ambient shadow — a soft seat under raised cards, buttons, and pills.
- **Accent glow** (`0 2px 10px -3px oklch(0.45 0.09 165 / 0.45)`): a single
  purposeful pine-green halo under the *selected* segmented-control option. Reserved;
  not a general hover effect.

### Named Rules
**The Tonal-Depth Rule.** Layer surfaces by tone first, border second, shadow last.
If two regions need separating, reach for `surface-raised` vs `surface-sunken`
and a `border-line` hairline before you reach for a shadow.

## 5. Components

### Buttons
- **Shape:** gently rounded (10px radius); pill geometry `px-[17px] py-[11px]`,
  `text-sm font-medium`.
- **Primary:** pine fill with white `accent-ink` label (`bg-accent text-accent-ink`),
  `shadow-sm`. The single highest-emphasis action on a view.
- **Ghost / Secondary:** transparent-to-raised surface with a `line-strong`
  border; hover fills to `surface-sunken`.
- **Hover / Focus:** primary darkens to `accent/90`; all buttons show a 2px
  `ring` focus ring with a 2px offset (`focus-visible:ring-2 ring-ring
  ring-offset-2`). Disabled drops to 50% opacity, `not-allowed` cursor.

### Chips / Badges
- **Style:** full-radius pill, hairline border + soft subtle fill,
  `text-xs font-medium`, `px-2 py-0.5`.
- **State:** account buckets use `border-{bucket}/40 bg-{bucket}-subtle
  text-{bucket}` (iris/violet/cyan/amber/teal); semantic tones (success/warning/
  disabled) follow the same border-tint/subtle-fill/colored-text pattern.
  `muted` is the uppercase metadata pill.

### Cards / Containers
- **Corner Style:** generously rounded (16px / `rounded-2xl`).
- **Background:** `surface-raised`; `tone="danger"` washes to `bg-negative/5`
  with a `border-negative/40`.
- **Shadow Strategy:** `shadow-sm` only (see Elevation).
- **Border:** a single `border-line` hairline (decorative, AA-exempt).
- **Internal Padding:** 24px (`p-6`); 20px bottom margin so stacked cards breathe.
- **Nesting:** forbidden. A card inside a card is always the wrong structure here.

### Inputs / Fields
- **Style:** `surface` fill, `input-line` border (the darker control border),
  6px radius, `px-3 py-2`, full-width with `min-w-0` so it shrinks inside flex
  parents (a frozen layout guard).
- **Focus:** border shifts to `accent` plus a 2px `ring` glow
  (`focus:border-accent focus:ring-2 focus:ring-ring`).
- **Numeric:** `type="text"` + `inputMode`, never `type="number"` — the
  spinner-less React Aria field keeps input height identical every paint
  (anti-jitter rule); clamp/strip lives in the change handler.
- **Disabled / Error:** disabled fills to `surface-sunken`, text to `muted`;
  errors render below in `text-negative` with `role="alert"`.

### Navigation (Sidebar)
- **Style:** vertical rail; rows are `rounded-md px-2.5 py-2 text-sm`. Section
  headers are `text-xs uppercase tracking-wider text-muted`.
- **States:** hover fills `surface-sunken` and lifts text to `ink`; the active
  route uses the pine accent; focus shows the 2px `ring`. Collapses to a mobile
  nav drawer on small screens.

### Signature Component — The In-House SVG Chart Engine
The app draws its own time-series charts (`components/charts/`), not a chart
library (recharts was removed). Charts render on `surface-raised`, resolve every
series color from the theme-keyed `tokens.ts` map (not runtime `getComputedStyle`),
and re-flip on the `.dark` swap. They carry a custom tooltip + crosshair,
drag-to-zoom with reset, per-member life-expectancy markers (1st death orange,
2nd death red), a retire marker, and a green/red net-change split. Marker labels
get a `paint-order: stroke` halo of the chart surface so they stay legible over
busy bands. Grid/axis/tooltip chrome comes from a *separate* neutral map
(`CHART_CHROME`) and is intentionally low-contrast (decoration, exempt from the
series AA gate).

## 6. Do's and Don'ts

### Do:
- **Do** set every comparable number in JetBrains Mono with tabular figures.
- **Do** carry account type with hue **and** a text label, never hue alone.
- **Do** use the pine accent as a fill with `accent-ink` text — and only as the
  single highest-emphasis action on a view (The One Voice Rule).
- **Do** build depth from tonal surfaces + a hairline first, shadow last.
- **Do** register any new color pair in `lib/contrast.ts` and prove it AA in both
  themes before shipping it.
- **Do** keep the 14px body baseline; earn comfort through hierarchy and spacing.
- **Do** disclose, in plain text inside a `role="note"` card, any figure the
  model estimates because the user didn't supply it — e.g. the Balance
  Projection's first-year Medicare (IRMAA) surcharge estimated from the
  projected first-year income when no two-years-prior income was provided. The
  disclosure is a real, keyboard-reachable, screen-reader-announced text node,
  never icon/colour-only.
- **Do** give every animation a `prefers-reduced-motion` alternative.

### Don't:
- **Don't** ship the **generic SaaS dashboard**: stock indigo-on-slate, hero-metric
  cards, or repeated identical icon+heading+text card grids.
- **Don't** drift toward **salesy fintech / robo-advisor** patterns: gamified
  confetti, "you're on track!" cheerleading, or nudges that hide the real numbers.
- **Don't** fall back to the **spreadsheet / legacy-finance** wall of
  undifferentiated gray with no hierarchy.
- **Don't** go **consumer-cute**: no mascots, pastel illustrations, emoji, or jokey
  copy on money decisions.
- **Don't** use the pine accent as small text on a light surface — it fails AA as
  text. Fill + `accent-ink` only.
- **Don't** introduce a second accent, raw `slate-*` / `indigo-*` utilities, or a
  `dark:` color twin. The semantic tokens are the sole color vocabulary; dark mode
  is a variable swap.
- **Don't** nest a card inside a card.
- **Don't** use `type="number"` inputs (spinner jitter) or `border-left`/`-right`
  greater than 1px as a colored accent stripe.
- **Don't** convey a meaningful state by color alone. State signals must carry a
  text label or icon so they survive color-blindness and grayscale (WCAG 2.2 AA).
