/**
 * Generic info-icon popover (i) affordance.
 *
 * A small `(i)` trigger button; pressing it (mouse or keyboard) opens a React
 * Aria Popover/Dialog holding arbitrary content, dismissed by Esc or an
 * outside press. Use anywhere a plain-language explainer or supplemental info
 * is needed inline (e.g. the HSA-qualified flag on the expense form).
 *
 * Intentionally NOT chart/print-scoped — see `ChartInfoPopover` for the
 * chart-titled variant that carries `report-print-hide` semantics.
 *
 * Built on the same React Aria `DialogTrigger`+`Button`+`Popover`+`Dialog`
 * shell as `ChartInfoPopover`. Self-contained: owns its
 * own `DialogTrigger`.
 */
import React from 'react';
import { Button, Dialog, DialogTrigger, Popover } from 'react-aria-components';
import { InfoCircleIcon } from './InfoCircleIcon';

export interface InfoPopoverProps {
  /** Accessible name for the trigger Button and the Dialog. */
  readonly label: string;
  /** Content rendered inside the popover. */
  readonly children: React.ReactNode;
}

const TRIGGER_CLASS =
  'inline-flex cursor-pointer items-center rounded text-muted hover:text-ink ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

export const InfoPopover: React.FC<InfoPopoverProps> = ({ label, children }) => (
  <DialogTrigger>
    <Button aria-label={label} className={TRIGGER_CLASS}>
      <InfoCircleIcon width={16} height={16} />
    </Button>
    <Popover offset={6} className="z-40 outline-none">
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
