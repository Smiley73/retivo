/**
 * Reusable chart "explain this" info-icon disclosure.
 *
 * A small `(i)` trigger sits next to a chart's title; pressing it (mouse
 * or keyboard) opens a React Aria Popover holding that chart's
 * methodology caption, dismissed by Esc or an outside press. Replaces the
 * always-on caption that previously sat below each Balance Projection
 * chart — the caption length is too long for a tooltip and a full modal is
 * heavier than a caption needs, so this uses the Popover/Dialog primitives.
 *
 * Self-contained: it owns its own `DialogTrigger` + trigger Button (like
 * `MonteCarloMethodologyModal`), unlike `SyncDetailsPopover` whose
 * `DialogTrigger` lives on the badge. The icon is decorative
 * (`aria-hidden`); the Button + Dialog carry the per-chart accessible name
 * via `label`. React Aria owns focus management, Esc, and outside-press.
 *
 * Built on React Aria's `Popover`/`Dialog`, reusing
 * `SyncDetailsPopover`'s Dialog chrome classes.
 */
import React from 'react';
import { Button, Dialog, DialogTrigger, Popover } from 'react-aria-components';
import { InfoCircleIcon } from './InfoCircleIcon';

export interface ChartInfoPopoverProps {
  /** Per-chart accessible name for the trigger Button + the Dialog
   *  (e.g. "About the Per-year projection chart"). */
  readonly label: string;
  /** The caption content rendered inside the popover. */
  readonly children: React.ReactNode;
}

// `report-print-hide` is part of the trigger class: every info-popover trigger hides in
// print with one edit — popovers are never useful on paper. Harmless app-wide.
const TRIGGER_CLASS =
  'report-print-hide inline-flex cursor-pointer items-center rounded text-muted hover:text-ink ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

export const ChartInfoPopover: React.FC<ChartInfoPopoverProps> = ({
  label,
  children,
}) => (
  <DialogTrigger>
    <Button aria-label={label} className={TRIGGER_CLASS}>
      <InfoCircleIcon width={16} height={16} />
    </Button>
    <Popover offset={6} className="report-print-hide z-40 outline-none">
      <Dialog
        aria-label={label}
        className={
          'max-w-sm rounded-lg border border-line bg-surface-raised p-3 ' +
          'text-xs text-muted shadow-lg outline-none'
        }
      >
        {children}
      </Dialog>
    </Popover>
  </DialogTrigger>
);
