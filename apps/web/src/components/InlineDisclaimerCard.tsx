/**
 * Shared point-of-use "illustrative only" disclaimer surface.
 *
 * Renders the canonical inline lead + closing (from `disclaimer-fragments`)
 * around a scope-specific middle, so the SS Optimizer, Projected withdrawals,
 * Guardrails, Balance Projection, and Dashboard disclaimer cards share
 * identical chrome +
 * legal framing. This component is only for the inline point-of-use surfaces.
 *
 * Variants:
 *   - `card` (default): a standing `role="note"` card (the Optimizer chrome).
 *     Composes `<strong>{LEAD}</strong> {children} {CLOSING}`.
 *   - `line`: a bare `role="note"` single line (no card chrome, no auto
 *     lead/closing) — the caller supplies the whole note (e.g. `TAX_SNAPSHOT_NOTE`
 *     on the Roth-conversions / QCD editor pages).
 *
 * Body text is deliberate fineprint (the disclaimer-card exception in
 * "Typography" of docs/ui-conventions.md): `text-xs` (default) or `text-sm` via `size="sm"`, rendered
 * directly (no `<Muted>`) so the red `valueNegativeClass` lead keeps its
 * warning weight.
 */
import React from 'react';
import { valueNegativeClass } from '../pages/accounts-page-chrome';
import {
  INLINE_DISCLAIMER_CLOSING,
  INLINE_DISCLAIMER_LEAD,
} from '../lib/disclaimer-fragments';

export interface InlineDisclaimerCardProps {
  /** Accessible name for the `role="note"` region. */
  readonly ariaLabel: string;
  /** Scope-specific middle (`card` variant) or the full note (`line` variant). */
  readonly children?: React.ReactNode;
  /** Extra classes on the outer element (layout/margin/grid span). */
  readonly className?: string;
  /** Body text size — `xs` fineprint (default) or `sm` baseline. */
  readonly size?: 'xs' | 'sm';
  /** `card` (bordered standing note, default) or `line` (bare inline note). */
  readonly variant?: 'card' | 'line';
}

/** Optimizer card chrome — the standing `role="note"` disclaimer surface. */
const CARD_CHROME = 'rounded-2xl border border-line bg-surface-raised p-6 shadow-sm';

export const InlineDisclaimerCard: React.FC<InlineDisclaimerCardProps> = ({
  ariaLabel,
  children,
  className,
  size = 'xs',
  variant = 'card',
}) => {
  const sizeClass = size === 'sm' ? 'text-sm' : 'text-xs';

  if (variant === 'line') {
    return (
      <p
        className={`m-0 ${sizeClass}${className ? ` ${className}` : ''}`}
        role="note"
        aria-label={ariaLabel}
      >
        {children}
      </p>
    );
  }

  return (
    <div
      className={`${CARD_CHROME}${className ? ` ${className}` : ''}`}
      role="note"
      aria-label={ariaLabel}
    >
      <p className={`m-0 ${sizeClass}`}>
        <strong className={valueNegativeClass}>{INLINE_DISCLAIMER_LEAD}</strong>{' '}
        {children} {INLINE_DISCLAIMER_CLOSING}
      </p>
    </div>
  );
};
