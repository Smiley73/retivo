/**
 * Inline status pill. `tone` maps to a semantic or account-bucket hue; `badgeToneForBucket` maps a bucket to its
 * tone.
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

/** Maps an account bucket to its Badge tone, keeping the bucket-to-chip mapping in one place. */
export function badgeToneForBucket(bucket: AccountBucket): BadgeTone {
  return bucket;
}

interface BadgeProps {
  children: React.ReactNode;
  tone?: BadgeTone;
  /**
   * `sm` is a smaller pill for a marker beside running text in a narrow column, e.g. the sidebar
   * "Beta" pill.
   */
  size?: 'md' | 'sm';
  className?: string;
}

const BASE_CLASS = 'inline-flex items-center rounded-full border font-medium';

// `sm` uses the 11px micro-label step; `text-xs` (12px) is the smallest default step.
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
  // Alias of `disabled` for the per-row "Needs attention" chip, which is semantically negative.
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
