/**
 * Hover and focus tooltip on React Aria `TooltipTrigger`; `Focusable` makes any child a keyboard-reachable trigger
 * and RA owns dismissal and hover delay.
 */
import React from 'react';
import {
  Focusable,
  Tooltip as RACTooltip,
  TooltipTrigger,
} from 'react-aria-components';

interface TooltipProps {
  children: React.ReactNode;
  content: React.ReactNode;
  /** Wraps the bubble across multiple lines. */
  multiline?: boolean;
  className?: string;
}

// Ring on `data-focus-visible` so the trigger is visibly focusable (WCAG 2.4.7).
const ANCHOR_CLASS =
  'inline-block cursor-help rounded-sm outline-none ' +
  'data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring data-[focus-visible]:ring-offset-1';

const BUBBLE_BASE_CLASS =
  'z-10 rounded-md px-2.5 py-1.5 text-xs ' +
  'bg-ink text-surface';

const BUBBLE_SINGLE_CLASS = 'whitespace-nowrap';

const BUBBLE_MULTILINE_CLASS =
  'w-max max-w-72 whitespace-normal text-left leading-snug';

export const Tooltip: React.FC<TooltipProps> = ({
  children,
  content,
  multiline = false,
  className,
}) => {
  const anchorClasses = className
    ? `${ANCHOR_CLASS} ${className}`
    : ANCHOR_CLASS;
  const bubbleClasses = [
    BUBBLE_BASE_CLASS,
    multiline ? BUBBLE_MULTILINE_CLASS : BUBBLE_SINGLE_CLASS,
  ].join(' ');

  return (
    <TooltipTrigger delay={0}>
      <Focusable>
        <span className={anchorClasses} tabIndex={0}>
          {children}
        </span>
      </Focusable>
      <RACTooltip offset={6} className={bubbleClasses}>
        {content}
      </RACTooltip>
    </TooltipTrigger>
  );
};
