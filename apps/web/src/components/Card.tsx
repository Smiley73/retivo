/**
 * Content card — the typed shared surface for the Graphite Spectrum
 * semantic-token system.
 *
 * An elevated surface with a hairline border, rounded corners,
 * comfortable padding, a soft shadow, and a default bottom margin so
 * stacked cards breathe. The `border-line` hairline is purely
 * decorative (WCAG 1.4.11-exempt — the surface fill + shadow + padding
 * convey the container; see "Decorative borders are exempt" under
 * "Contrast" in docs/ui-conventions.md). `tone="danger"` is a soft
 * destructive wash.
 *
 * Dark mode is the `.dark` CSS-variable swap — no `dark:` colour twins.
 * Visual style only — no behavioral contract.
 */
import React from 'react';

type CardTone = 'default' | 'danger';

interface CardProps {
  children: React.ReactNode;
  /** `danger` surfaces a soft-red destructive zone (legacy `.card--danger`). */
  tone?: CardTone;
  /** Extra layout-only classes appended after the base card classes. */
  className?: string;
  /** Runtime-dynamic values only (static styling belongs in classes). */
  style?: React.CSSProperties;
  id?: string;
  /** ARIA landmark / semantic role (e.g. `"note"` for a standalone disclosure card). */
  role?: React.AriaRole;
}

const BASE_CLASS =
  'mb-5 rounded-2xl border p-6 shadow-sm ' +
  'border-line bg-surface-raised';

const TONE_CLASS: Record<CardTone, string> = {
  default: '',
  danger: 'border-negative/40 bg-negative/5',
};

export const Card: React.FC<CardProps> = ({
  children,
  tone = 'default',
  className,
  style,
  id,
  role,
}) => {
  const classes = [BASE_CLASS, TONE_CLASS[tone], className]
    .filter(Boolean)
    .join(' ');
  return (
    // eslint-disable-next-line no-restricted-syntax -- forwards the caller-supplied runtime `style` prop (passthrough API), not a static style
    <div id={id} role={role} className={classes} style={style}>
      {children}
    </div>
  );
};
