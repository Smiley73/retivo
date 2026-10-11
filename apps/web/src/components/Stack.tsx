/**
 * Vertical flex stack — the typed Tailwind-defaults replacement for the
 * legacy `.stack` utility class.
 *
 * Lays children out vertically with a consistent gap (the legacy
 * `.stack`: `display:flex; flex-direction:column; gap:0.5rem`).
 * Layout-only — gap / alignment overrides go through `className`.
 */
import React from 'react';

interface StackProps {
  children: React.ReactNode;
  className?: string;
  /** Runtime-dynamic values only (static styling belongs in classes). */
  style?: React.CSSProperties;
}

const STACK_CLASS = 'flex flex-col gap-2';

export const Stack: React.FC<StackProps> = ({ children, className, style }) => {
  const classes = className ? `${STACK_CLASS} ${className}` : STACK_CLASS;
  return (
    // eslint-disable-next-line no-restricted-syntax -- forwards the caller-supplied runtime `style` prop (passthrough API), not a static style
    <div className={classes} style={style}>
      {children}
    </div>
  );
};
