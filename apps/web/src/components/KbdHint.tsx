/**
 * Keyboard hint — the typed Tailwind-defaults replacement for the
 * legacy `.kbd-hint` class.
 *
 * Small muted helper line shown under dialog button rows (e.g.
 * "Press Enter to save · Esc to cancel"). Matches the legacy
 * `.kbd-hint` contract: extra-small, muted, a small top margin.
 *
 * Visual style only — no behavioral contract.
 */
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
