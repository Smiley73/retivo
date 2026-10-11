/**
 * Shared button vocabulary for the `components/`-level modal dialogs
 * (Graphite Spectrum semantic tokens).
 * The shared `button` / `button.secondary` / `button.danger` vocabulary
 * the dialog chrome leans on.
 *
 * Why this lives under `components/` (not the `pages/*-page-chrome`
 * modules that own the same strings for page sweeps): the page chrome
 * modules `import` typed components from `components/` (`Field`,
 * `Muted`). A dialog component reaching back into a `pages/*-chrome`
 * module for these strings would form a `components/ → pages/ →
 * components/` import cycle. This module keeps the dependency direction
 * clean — `components/` depends only on `components/`. The class strings
 * are intentionally identical to the canonical
 * `accounts-page-chrome.tsx` definitions (same AA-safe pairs).
 *
 * Visual style only — no behavioral contract. Every fg/bg pair is an
 * AA-safe Tailwind-default pair from apps/web/src/lib/contrast.ts.
 */

/**
 * Primary action button. The lime accent fill with the dark `accent-ink`
 * label (`bg-accent text-accent-ink`, 7.97:1 light / 10.68:1 dark — the
 * bright lime is too light for white text). Dark mode is the same tokens
 * re-pointed by the `.dark` variable swap; no `dark:` twins. Registered
 * "primary button label on accent" in contrast.ts.
 */
export const btnPrimaryClass =
  'inline-flex items-center justify-center rounded-md ' +
  'bg-accent px-4 py-2 text-sm font-medium text-accent-ink shadow-sm ' +
  'transition-colors hover:bg-accent/90 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/** Outlined secondary button — raised surface, strong hairline, accent-link green label. */
export const btnSecondaryClass =
  'inline-flex items-center justify-center rounded-md ' +
  'border border-line-strong bg-surface-raised px-4 py-2 text-sm font-medium text-accent-link ' +
  'transition-colors hover:bg-surface-sunken focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Destructive button. The `surface` token as the label on the negative
 * red fill (`bg-negative text-surface`) — near-white in light (6.33:1),
 * near-black in dark (7.49:1) via the `.dark` variable swap, so a single
 * token reads in both themes. Registered "danger button label on danger"
 * in contrast.ts.
 */
export const btnDangerClass =
  'inline-flex items-center justify-center rounded-md ' +
  'bg-negative px-4 py-2 text-sm font-medium text-surface shadow-sm ' +
  'transition-colors hover:bg-negative/90 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Outlined secondary button at the small size (row / inline actions). A
 * **standalone** class string — not `${btnSecondaryClass} ${btnSmClass}`
 * — because Tailwind v4 emits same-specificity utilities in numeric
 * source order, so the role class's `px-4 py-2` would beat the
 * fragment's `px-2.5 py-1` regardless of className order (the concat path
 * was a silent no-op on padding). Intentionally byte-identical to the
 * canonical `accounts-page-chrome.tsx` standalone definition; the AA-safe
 * fg/bg pair is unchanged. See "Buttons and destructive actions" in
 * docs/ui-conventions.md.
 */
export const btnSecondarySmClass =
  'inline-flex items-center justify-center rounded-md ' +
  'border border-line-strong bg-surface-raised px-2.5 py-1 text-xs text-accent-link ' +
  'transition-colors hover:bg-surface-sunken focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Text-entry class for `components/`-level dialogs. Intentionally byte-identical
 * to the canonical `accounts-page-chrome.tsx` `inputClass` (same AA-safe pairs)
 * — kept here so a dialog component doesn't reach back into a `pages/*-chrome`
 * module (the `components/ → pages/ → components/` cycle the button classes
 * above avoid). Visual style only.
 */
export const inputClass =
  'block w-full min-w-0 rounded-md border border-input-line bg-surface px-3 py-2 ' +
  'text-ink placeholder:text-muted ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted';
