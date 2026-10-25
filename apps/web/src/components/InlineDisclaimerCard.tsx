/**
 * Point-of-use "illustrative only" disclaimer: `card` wraps a scope-specific middle in the canonical lead and
 * closing, `line` is a bare note. Not wrapped in `<Muted>`, so the red lead keeps its weight.
 */
import React from 'react';
import { valueNegativeClass } from '../pages/accounts-page-chrome';
import {
  INLINE_DISCLAIMER_CLOSING,
  INLINE_DISCLAIMER_LEAD,
} from '../lib/disclaimer-fragments';

export interface InlineDisclaimerCardProps {
  readonly ariaLabel: string;
  readonly children?: React.ReactNode;
  readonly className?: string;
  readonly size?: 'xs' | 'sm';
  readonly variant?: 'card' | 'line';
}

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
