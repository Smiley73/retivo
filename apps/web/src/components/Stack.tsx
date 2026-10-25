/** Vertical flex stack with a consistent gap; layout-only, overrides go through `className`. */
import React from 'react';

interface StackProps {
  children: React.ReactNode;
  className?: string;
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
