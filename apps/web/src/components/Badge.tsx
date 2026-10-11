/**
 * Badge / chip — the typed inline-status pill for the Graphite Spectrum
 * semantic-token system.
 *
 * A small rounded pill (border + soft fill) for inline status. The
 * `tone` prop maps each status to a semantic / account-bucket hue whose
 * text-on-subtle-fill pair clears the WCAG AA allowlist
 * (apps/web/src/lib/contrast.ts). The type-coded buckets lead — the
 * `scenario` pill uses the iris (pre-tax) hue, `essential` the cyan
 * (taxable) hue, `discretionary` the violet (Roth) hue. Dark mode is the
 * `.dark` CSS-variable swap — no `dark:` colour twins. `neutral` is the
 * bare default; `muted` is the uppercase metadata pill.
 *
 * The five account-bucket tones (`pretax` / `roth` / `taxable` / `cash` /
 * `tax_free`) are the self-documenting names for the type-chip on the
 * account tables — iris / violet / cyan / amber / teal hues; the legacy
 * `scenario` / `discretionary` / `essential` aliases borrow the first
 * three. Map a bucket to its tone with `badgeToneForBucket`.
 *
 * Visual style only — no behavioral contract.
 */
import React from 'react';
import type { AccountBucket } from '../lib/account-bucket';

export type BadgeTone =
  | 'neutral'
  | 'muted'
  | 'success'
  | 'modified'
  | 'scenario'
  | 'disabled'
  | 'negative'
  | 'essential'
  | 'discretionary'
  | 'pretax'
  | 'roth'
  | 'taxable'
  | 'cash'
  | 'tax_free';

/**
 * Account-bucket → Badge tone. Keeps the bucket-to-chip mapping in one
 * place so both flagship account tables stay DRY. The four bucket tones
 * are named identically to the buckets, so this is a structural identity
 * — but routing through it documents the dependency and guards against a
 * future bucket whose name diverges from its tone.
 */
export function badgeToneForBucket(bucket: AccountBucket): BadgeTone {
  return bucket;
}

interface BadgeProps {
  children: React.ReactNode;
  tone?: BadgeTone;
  /**
   * `sm` — a smaller pill (11px type, tighter horizontal padding, no vertical
   * padding) for a marker that sits beside running text in a narrow column,
   * e.g. the sidebar's "Beta" pill, where the default pill's width forced
   * the nav label onto a second line.
   */
  size?: 'md' | 'sm';
  className?: string;
}

const BASE_CLASS = 'inline-flex items-center rounded-full border font-medium';

// `sm` uses the Graphite Spectrum 11px micro-label step (the same irreducible
// value the `.pick-l` / `.kpi .k` mock labels use) — `text-xs` (12px) is the
// smallest default type step, and the owner asked for the pill to sit a step
// below the nav label.
const SIZE_CLASS: Record<NonNullable<BadgeProps['size']>, string> = {
  md: 'px-2 py-0.5 text-xs',
  // eslint-disable-next-line no-restricted-syntax -- irreducible Graphite Spectrum micro-label type scale (11px) for the compact pill
  sm: 'px-1.5 py-0 text-[11px] leading-4',
};

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: 'border-line bg-surface-sunken text-muted',
  muted: 'border-line bg-surface-sunken text-muted uppercase tracking-wide',
  success: 'border-positive/40 bg-surface-sunken text-positive',
  modified: 'border-warning/40 bg-surface-raised text-warning',
  scenario: 'border-pretax/40 bg-pretax-subtle text-pretax',
  disabled: 'border-negative/40 bg-surface-sunken text-negative',
  // "Needs attention" chip (per-row problem badge). Byte-identical alias of
  // `disabled` — semantically negative rather than disabled. Reuses the
  // already-registered contrast.ts pair (light: line 150; dark: added
  // alongside this tone).
  negative: 'border-negative/40 bg-surface-sunken text-negative',
  essential: 'border-taxable/40 bg-taxable-subtle text-taxable',
  discretionary: 'border-roth/40 bg-roth-subtle text-roth',
  pretax: 'border-pretax/40 bg-pretax-subtle text-pretax',
  roth: 'border-roth/40 bg-roth-subtle text-roth',
  taxable: 'border-taxable/40 bg-taxable-subtle text-taxable',
  cash: 'border-cash/40 bg-cash-subtle text-cash',
  tax_free: 'border-tax_free/40 bg-tax_free-subtle text-tax_free',
};

export const Badge: React.FC<BadgeProps> = ({
  children,
  tone = 'neutral',
  size = 'md',
  className,
}) => {
  const classes = [BASE_CLASS, SIZE_CLASS[size], TONE_CLASS[tone], className]
    .filter(Boolean)
    .join(' ');
  return <span className={classes}>{children}</span>;
};
