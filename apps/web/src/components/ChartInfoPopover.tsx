/**
 * Info-icon disclosure beside a chart title that opens a React Aria Popover with the chart's methodology caption.
 * Self-contained: owns its `DialogTrigger`; the icon is decorative and `label` carries the accessible name.
 */
import React from 'react';
import { Button, Dialog, DialogTrigger, Popover } from 'react-aria-components';
import { InfoCircleIcon } from './InfoCircleIcon';

export interface ChartInfoPopoverProps {
  /** Per-chart accessible name for the trigger and the dialog. */
  readonly label: string;
  readonly children: React.ReactNode;
}

// `report-print-hide`: popovers are never useful on paper.
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
