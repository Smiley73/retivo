/**
 * Hover/focus tooltip — built on React Aria's `TooltipTrigger` /
 * `Tooltip`. The public API is FROZEN (consumers untouched): `children` (the hover/focus target),
 * `content` (bubble body), optional `multiline`, optional layout-only
 * `className`.
 *
 * React Aria owns the full tooltip a11y + interaction contract by
 * construction: pointer hover AND keyboard focus reveal it (a
 * keyboard-only user can surface it — the behavioral improvement the
 * legacy mouse-only handlers lacked), it is exposed via `role="tooltip"`
 * + the trigger's `aria-describedby`, it dismisses on Esc / blur /
 * leave, and it honors the platform hover-intent delay. The arbitrary
 * child is wrapped in React Aria's `Focusable` so any element (icon,
 * text, badge) becomes a valid, focusable tooltip trigger.
 */
import React from 'react';
import {
  Focusable,
  Tooltip as RACTooltip,
  TooltipTrigger,
} from 'react-aria-components';

interface TooltipProps {
  /** The hover/focus target (icon, text, badge). */
  children: React.ReactNode;
  /** Tooltip body content. */
  content: React.ReactNode;
  /** Multi-line wrapping bubble (legacy `.tooltip--multiline`). */
  multiline?: boolean;
  /** Layout-only classes on the anchor wrapper. */
  className?: string;
}

// React Aria's `Focusable` sets `data-focus-visible` on the child on keyboard
// focus; pair it with a ring so the tooltip trigger is visibly focusable
// (WCAG 2.4.7) instead of the bare `outline-none`.
const ANCHOR_CLASS =
  'inline-block cursor-help rounded-sm outline-none ' +
  'data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring data-[focus-visible]:ring-offset-1';

// Inverse bubble — the `ink` fill with the `surface` text, so it swaps
// dark-on-light → light-on-dark with the `.dark` variable change (17.97:1
// light / 17.17:1 dark). Registered "tooltip text on ink bubble" in
// contrast.ts.
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
      {/* Focusable makes the arbitrary child a real keyboard- and
          pointer-reachable trigger; tabIndex=0 keeps the legacy
          "any anchor is focusable" contract. */}
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
