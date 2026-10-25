/**
 * Wrapping, vertically-centred horizontal flex row with a consistent gap; layout-only, overrides go through
 * `className`.
 */
import React from 'react';

interface RowProps {
  children: React.ReactNode;
  className?: string;
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
