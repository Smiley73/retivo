/**
 * Elevated content surface with a hairline border and default bottom margin; the border is decorative ("Contrast" in
 * docs/ui-conventions.md). `tone="danger"` is a soft destructive wash.
 */
import React from 'react';

type CardTone = 'default' | 'danger';

interface CardProps {
  children: React.ReactNode;
  tone?: CardTone;
  className?: string;
  style?: React.CSSProperties;
  id?: string;
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
