/**
 * Horizontal flex row — the typed Tailwind-defaults replacement for the
 * legacy `.row` utility class.
 *
 * Lays children out in a wrapping, vertically-centered flex row with a
 * consistent gap (the legacy `.row`: `display:flex; gap:0.75rem;
 * align-items:center; flex-wrap:wrap`). Layout-only — extra spacing /
 * alignment overrides go through `className`.
 */
import React from 'react';

interface RowProps {
  children: React.ReactNode;
  className?: string;
  /** Runtime-dynamic values only (static styling belongs in classes). */
  style?: React.CSSProperties;
}

const ROW_CLASS = 'flex flex-wrap items-center gap-3';

export const Row: React.FC<RowProps> = ({ children, className, style }) => {
  const classes = className ? `${ROW_CLASS} ${className}` : ROW_CLASS;
  return (
    // eslint-disable-next-line no-restricted-syntax -- forwards the caller-supplied runtime `style` prop (passthrough API), not a static style
    <div className={classes} style={style}>
      {children}
    </div>
  );
};
