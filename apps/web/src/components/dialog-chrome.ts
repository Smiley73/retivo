/**
 * Button and input class strings for `components/` dialogs, kept here to avoid a `components/ → pages/ → components/`
 * cycle. Source-order rationale: "Buttons and destructive actions" in docs/ui-conventions.md.
 */

/** Primary action button. */
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

/** Destructive button. */
export const btnDangerClass =
  'inline-flex items-center justify-center rounded-md ' +
  'bg-negative px-4 py-2 text-sm font-medium text-surface shadow-sm ' +
  'transition-colors hover:bg-negative/90 focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Outlined secondary button at the small size; standalone because concatenating size classes loses
 * to source order.
 */
export const btnSecondarySmClass =
  'inline-flex items-center justify-center rounded-md ' +
  'border border-line-strong bg-surface-raised px-2.5 py-1 text-xs text-accent-link ' +
  'transition-colors hover:bg-surface-sunken focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

/** Text-entry class for `components/`-level dialogs. */
export const inputClass =
  'block w-full min-w-0 rounded-md border border-input-line bg-surface px-3 py-2 ' +
  'text-ink placeholder:text-muted ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted';
