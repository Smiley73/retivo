/** Small muted helper line under dialog button rows, e.g. "Press Enter to save · Esc to cancel". */
import React from 'react';

interface KbdHintProps {
  children: React.ReactNode;
  className?: string;
}

const KBD_HINT_CLASS = 'mt-0.5 text-xs text-muted';

export const KbdHint: React.FC<KbdHintProps> = ({ children, className }) => {
  const classes = className
    ? `${KBD_HINT_CLASS} ${className}`
    : KBD_HINT_CLASS;
  return <p className={classes}>{children}</p>;
};
